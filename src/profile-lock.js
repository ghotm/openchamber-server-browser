import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEASE_DIRECTORY = '.openchamber-lease';
const OWNER_FILE = 'owner.json';
const CHROME_LOCK_FILES = Object.freeze(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
const LEASE_ATTEMPTS = 3;
const LEASE_RETRY_MS = 200;

export const LEASE_HEARTBEAT_MS = 10_000;
export const LEASE_STALE_MS = 45_000;

const delay = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

const leasePath = (profileDir) => path.join(profileDir, LEASE_DIRECTORY);

const errorWithCode = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const describedError = (message, cause) => {
  const code = cause?.code ? ` (${cause.code})` : '';
  const error = new Error(`${message}: ${cause?.message ?? String(cause)}${code}`);
  error.cause = cause;
  return error;
};

export const parseSingletonTarget = (target) => {
  const match = /^(.+)-(\d+)$/.exec(String(target ?? ''));
  if (!match) return null;
  const pid = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return { hostname: match[1], pid };
};

export const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else. Unknown
    // errors are treated as alive so a lock is never removed without proof.
    return error?.code !== 'ESRCH';
  }
};

const readLink = async (file, dependencies) => {
  try {
    return await dependencies.readlink(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw describedError(`Cannot read ${file}`, error);
  }
};

const lockMessage = (profileDir, state, owner, reason) => {
  if (state === 'active') {
    return `Chrome profile is already in use by ${owner.hostname} PID ${owner.pid}. Close that browser before starting another one for this chat.`;
  }
  if (state === 'foreign') {
    return `Chrome profile ${profileDir} has a lock from host ${owner.hostname} PID ${owner.pid}, and this installation has no prior lease. Stop the old service and remove SingletonLock, SingletonCookie, SingletonSocket and ${LEASE_DIRECTORY} once before upgrading.`;
  }
  return `Chrome profile ${profileDir} has an unreadable ${reason ?? 'SingletonLock'}. Confirm no Chrome is using it, then remove SingletonLock, SingletonCookie and SingletonSocket.`;
};

export const inspectChromeLock = async (profileDir, {
  platform = process.platform,
  hostname = os.hostname(),
  pidAlive = isProcessAlive,
  readlink = fs.promises.readlink,
  lstat = fs.promises.lstat,
  allowForeign = false,
} = {}) => {
  if (platform === 'win32') return { state: 'missing' };
  const lock = path.join(profileDir, 'SingletonLock');
  let info;
  try {
    info = await lstat(lock);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    throw describedError(`Cannot inspect ${lock}`, error);
  }
  if (!info.isSymbolicLink()) {
    return { state: 'unrecognized', reason: 'SingletonLock is not a symlink' };
  }
  const target = await readLink(lock, { readlink });
  const owner = parseSingletonTarget(target);
  if (!owner) {
    return { state: 'unrecognized', reason: `SingletonLock target ${JSON.stringify(target)} is not <hostname>-<pid>` };
  }
  if (owner.hostname === hostname) {
    return pidAlive(owner.pid)
      ? { state: 'active', owner, message: lockMessage(profileDir, 'active', owner) }
      : { state: 'stale', owner, reason: 'the owning process is gone' };
  }
  if (!allowForeign) {
    return { state: 'foreign', owner, message: lockMessage(profileDir, 'foreign', owner) };
  }
  return { state: 'stale', owner, reason: 'the previous lease was stale' };
};

export const clearChromeLock = async (profileDir, {
  lstat = fs.promises.lstat,
  rm = fs.promises.rm,
} = {}) => {
  for (const name of CHROME_LOCK_FILES) {
    const file = path.join(profileDir, name);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw describedError(`Cannot inspect ${file}`, error);
    }
    if (name === 'SingletonLock' && !info.isSymbolicLink()) {
      throw new Error(`${file} is not a symlink. Confirm no Chrome is using this profile before removing it.`);
    }
    await rm(file, { force: true }).catch((error) => {
      throw describedError(`Cannot remove ${file}`, error);
    });
  }
};

const readLeaseOwner = async (leaseDir, {
  readFile = fs.promises.readFile,
} = {}) => {
  const file = path.join(leaseDir, OWNER_FILE);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOTDIR') {
      throw new Error(`Cannot read the profile lease at ${leaseDir} (${error.code}). Fix its permissions or remove the directory before retrying.`);
    }
    throw describedError(`Cannot read the profile lease at ${leaseDir}`, error);
  }
  try {
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== 'object' || !Number.isFinite(owner.updatedAt)) {
      return { state: 'invalid' };
    }
    return { state: 'owner', owner };
  } catch {
    return { state: 'invalid' };
  }
};

const writeOwnerAtomic = async (leaseDir, owner, {
  writeFile = fs.promises.writeFile,
  rename = fs.promises.rename,
  rm = fs.promises.rm,
  randomSuffix = () => crypto.randomBytes(6).toString('hex'),
} = {}) => {
  const temporary = path.join(leaseDir, `.owner.tmp-${randomSuffix()}`);
  try {
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
    // Renaming into the lease directory refreshes its mtime. That mtime is the
    // fallback used when owner.json is missing or incomplete.
    await rename(temporary, path.join(leaseDir, OWNER_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

const removeLease = async (leaseDir, { rm = fs.promises.rm } = {}) => {
  await rm(leaseDir, { recursive: true, force: true });
};

const createLease = async (leaseDir, profileDir, {
  hostname,
  pid,
  heartbeatMs,
  now,
  writeFile,
  rename,
  rm,
  randomSuffix,
  onLost,
}) => {
  const startedAt = now();
  const base = { version: 1, hostname, pid, profileDir, startedAt };
  let current = { ...base, updatedAt: startedAt };
  let released = false;
  let lost = false;
  let heartbeat = Promise.resolve();

  const write = async () => {
    current = { ...base, updatedAt: now() };
    await writeOwnerAtomic(leaseDir, current, { writeFile, rename, rm, randomSuffix });
  };

  const reportLost = (error) => {
    if (lost || released) return;
    lost = true;
    queueMicrotask(() => {
      Promise.resolve(onLost?.(error)).catch(() => {});
    });
  };

  try {
    await write();
  } catch (error) {
    await removeLease(leaseDir, { rm }).catch(() => {});
    throw describedError(`Cannot create the profile lease at ${leaseDir}`, error);
  }

  const timer = setInterval(() => {
    if (released || lost) return;
    heartbeat = heartbeat.then(async () => {
      if (released || lost) return;
      try {
        await write();
      } catch (error) {
        reportLost(error);
      }
    });
  }, heartbeatMs);
  timer.unref?.();

  let releasePromise = null;
  return {
    owner: current,
    leaseDir,
    release() {
      if (released) return Promise.resolve();
      if (!releasePromise) {
        clearInterval(timer);
        releasePromise = (async () => {
          await heartbeat.catch(() => {});
          try {
            await removeLease(leaseDir, { rm });
            released = true;
          } catch (error) {
            releasePromise = null;
            throw describedError(`Cannot remove the profile lease at ${leaseDir}`, error);
          }
        })();
      }
      return releasePromise;
    },
  };
};

export const profileLeaseExists = async (profileDir, {
  lstat = fs.promises.lstat,
} = {}) => {
  const leaseDir = leasePath(profileDir);
  try {
    const info = await lstat(leaseDir);
    if (!info.isDirectory()) throw new Error(`${leaseDir} is not a directory`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOTDIR') {
      throw new Error(`Cannot read the profile lease at ${leaseDir} (${error.code}). Fix its permissions or remove the directory before retrying.`);
    }
    if (error?.message?.includes('is not a directory')) throw error;
    throw describedError(`Cannot read the profile lease at ${leaseDir}`, error);
  }
};

export const acquireProfileLease = async (profileDir, {
  hostname = os.hostname(),
  pid = process.pid,
  heartbeatMs = LEASE_HEARTBEAT_MS,
  staleMs = LEASE_STALE_MS,
  now = Date.now,
  mkdir = fs.promises.mkdir,
  readFile = fs.promises.readFile,
  writeFile = fs.promises.writeFile,
  rename = fs.promises.rename,
  rm = fs.promises.rm,
  lstat = fs.promises.lstat,
  randomSuffix = () => crypto.randomBytes(6).toString('hex'),
  onLost = null,
} = {}) => {
  const leaseDir = leasePath(profileDir);
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(leaseDir, { mode: 0o700 });
      return await createLease(leaseDir, profileDir, {
        hostname, pid, heartbeatMs, now, writeFile, rename, rm, randomSuffix, onLost,
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw describedError(`Cannot create the profile lease at ${leaseDir}`, error);
      }
    }

    const ownerState = await readLeaseOwner(leaseDir, { readFile });
    let leaseInfo;
    try {
      leaseInfo = await lstat(leaseDir);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOTDIR') {
        throw new Error(`Cannot read the profile lease at ${leaseDir} (${error.code}). Fix its permissions or remove the directory before retrying.`);
      }
      throw describedError(`Cannot read the profile lease at ${leaseDir}`, error);
    }
    if (!leaseInfo.isDirectory()) {
      throw new Error(`${leaseDir} is not a directory. Confirm no process is using this profile before removing it.`);
    }

    if (ownerState.state === 'owner') {
      const age = now() - ownerState.owner.updatedAt;
      if (age <= staleMs) {
        throw new Error(`Profile ${profileDir} is leased by host ${ownerState.owner.hostname} PID ${ownerState.owner.pid} (heartbeat ${Math.max(0, Math.round(age / 1000))}s ago). Wait for it to stop, or stop that service first.`);
      }
    } else {
      const age = now() - leaseInfo.mtimeMs;
      if (age <= staleMs) {
        if (attempt < LEASE_ATTEMPTS - 1) {
          await delay(LEASE_RETRY_MS);
          continue;
        }
        throw new Error(`Cannot read the profile lease at ${leaseDir}. It is too new to take over. Remove it only after confirming no Chrome is using this profile.`);
      }
    }

    try {
      await removeLease(leaseDir, { rm });
    } catch (error) {
      throw describedError(`Cannot remove the stale profile lease at ${leaseDir}`, error);
    }
  }
  throw new Error(`Cannot acquire the profile lease at ${leaseDir} after ${LEASE_ATTEMPTS} attempts`);
};

export const recoverProfile = async (profileDir, options = {}) => {
  const hadPriorLease = await profileLeaseExists(profileDir, options);
  let lease = null;
  try {
    lease = await acquireProfileLease(profileDir, options);
    const lock = await inspectChromeLock(profileDir, {
      ...options,
      allowForeign: hadPriorLease,
    });
    if (lock.state === 'missing') return lease;
    if (lock.state === 'stale') {
      await clearChromeLock(profileDir, options);
      return lease;
    }
    const error = new Error(lock.message ?? lockMessage(profileDir, lock.state, lock.owner, lock.reason));
    error.code = 'PROFILE_LOCK';
    throw error;
  } catch (error) {
    if (!lease) throw error;
    const current = lease;
    lease = null;
    try {
      await current.release();
    } catch (releaseError) {
      const combined = describedError(error.message, releaseError);
      combined.code = error.code;
      throw combined;
    }
    throw error;
  }
};
