import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LEASE_STALE_MS,
  acquireProfileLease,
  clearChromeLock,
  inspectChromeLock,
  isProcessAlive,
  parseSingletonTarget,
  profileLeaseExists,
  recoverProfile,
} from '../src/profile-lock.js';

const leaseDir = (profile) => path.join(profile, '.openchamber-lease');
const ownerFile = (profile) => path.join(leaseDir(profile), 'owner.json');

const profile = async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-profile-lock-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
};

const exists = async (file) => {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const writeLock = async (directory, target, socket = '/tmp/openchamber-missing-socket') => {
  await fs.promises.symlink(target, path.join(directory, 'SingletonLock'));
  await fs.promises.symlink('123456', path.join(directory, 'SingletonCookie'));
  await fs.promises.symlink(socket, path.join(directory, 'SingletonSocket'));
};

test('parses a hostname with hyphens and a numeric pid', () => {
  assert.deepEqual(parseSingletonTarget('old-container-12345'), { hostname: 'old-container', pid: 12345 });
  assert.equal(parseSingletonTarget('no-pid'), null);
  assert.equal(parseSingletonTarget('host-0'), null);
  assert.equal(parseSingletonTarget(null), null);
});

test('treats a missing process as dead and a permission error as alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999_999), false);
});

test('reports a missing lock without touching the profile', async (context) => {
  const directory = await profile(context);
  assert.deepEqual(await inspectChromeLock(directory, { hostname: 'host' }), { state: 'missing' });
});

test('treats a dead same-host owner as stale', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'host-123');
  const result = await inspectChromeLock(directory, { hostname: 'host', pidAlive: () => false });
  assert.equal(result.state, 'stale');
});

test('treats a live same-host owner as active', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'host-123');
  const result = await inspectChromeLock(directory, { hostname: 'host', pidAlive: () => true });
  assert.equal(result.state, 'active');
  assert.match(result.message, /already in use/i);
});

test('treats a foreign lock as foreign unless a prior lease proves it stale', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'old-host-123');
  assert.equal((await inspectChromeLock(directory, { hostname: 'new-host' })).state, 'foreign');
  assert.equal((await inspectChromeLock(directory, {
    hostname: 'new-host',
    allowForeign: true,
  })).state, 'stale');
});

test('rejects a non-symlink SingletonLock and keeps it', async (context) => {
  const directory = await profile(context);
  const lock = path.join(directory, 'SingletonLock');
  await fs.promises.writeFile(lock, 'not a link');
  const result = await inspectChromeLock(directory, { hostname: 'host' });
  assert.equal(result.state, 'unrecognized');
  assert.equal(await exists(lock), true);
});

test('rejects a malformed SingletonLock target', async (context) => {
  const directory = await profile(context);
  await fs.promises.symlink('not-a-valid-target', path.join(directory, 'SingletonLock'));
  const result = await inspectChromeLock(directory, { hostname: 'host' });
  assert.equal(result.state, 'unrecognized');
});

test('removes only the three Chrome lock entries', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'host-123');
  await fs.promises.writeFile(path.join(directory, 'keep.txt'), 'keep');
  await clearChromeLock(directory);
  assert.equal(await exists(path.join(directory, 'SingletonLock')), false);
  assert.equal(await exists(path.join(directory, 'SingletonCookie')), false);
  assert.equal(await exists(path.join(directory, 'SingletonSocket')), false);
  assert.equal(await exists(path.join(directory, 'keep.txt')), true);
});

test('skips Chrome lock inspection on Windows', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'host-123');
  assert.deepEqual(await inspectChromeLock(directory, { platform: 'win32' }), { state: 'missing' });
});

test('acquires a lease and rejects a concurrent owner', async (context) => {
  const directory = await profile(context);
  const first = await acquireProfileLease(directory, {
    hostname: 'host-a',
    pid: 100,
    heartbeatMs: 1_000,
    now: () => 10_000,
  });
  try {
    await assert.rejects(
      acquireProfileLease(directory, {
        hostname: 'host-b',
        pid: 200,
        heartbeatMs: 1_000,
        now: () => 10_000,
      }),
      /leased by host host-a PID 100/i,
    );
  } finally {
    await first.release();
  }
  assert.equal(await exists(leaseDir(directory)), false);
});

test('takes over a stale lease after the heartbeat window', async (context) => {
  const directory = await profile(context);
  const stale = path.join(leaseDir(directory));
  await fs.promises.mkdir(stale, { recursive: true });
  await fs.promises.writeFile(ownerFile(directory), JSON.stringify({
    version: 1,
    hostname: 'old-host',
    pid: 100,
    profileDir: directory,
    startedAt: 1,
    updatedAt: 1,
  }));
  const now = Date.now() + LEASE_STALE_MS + 1_000;
  const lease = await acquireProfileLease(directory, {
    hostname: 'new-host',
    pid: 200,
    heartbeatMs: 1_000,
    now: () => now,
  });
  try {
    assert.equal(JSON.parse(await fs.promises.readFile(ownerFile(directory), 'utf8')).hostname, 'new-host');
  } finally {
    await lease.release();
  }
});

test('does not take over a fresh lease whose owner file is missing', async (context) => {
  const directory = await profile(context);
  await fs.promises.mkdir(leaseDir(directory), { recursive: true });
  await assert.rejects(
    acquireProfileLease(directory, {
      hostname: 'new-host',
      heartbeatMs: 1_000,
      now: () => Date.now(),
    }),
    /too new to take over/i,
  );
  assert.equal(await exists(leaseDir(directory)), true);
});

test('does not take over a fresh lease whose owner file is malformed', async (context) => {
  const directory = await profile(context);
  await fs.promises.mkdir(leaseDir(directory), { recursive: true });
  await fs.promises.writeFile(ownerFile(directory), '{');
  await assert.rejects(
    acquireProfileLease(directory, {
      hostname: 'new-host',
      heartbeatMs: 1_000,
      now: () => Date.now(),
    }),
    /too new to take over/i,
  );
});

test('takes over a malformed lease after its directory is stale', async (context) => {
  const directory = await profile(context);
  await fs.promises.mkdir(leaseDir(directory), { recursive: true });
  await fs.promises.writeFile(ownerFile(directory), '{');
  const lease = await acquireProfileLease(directory, {
    hostname: 'new-host',
    heartbeatMs: 1_000,
    now: () => Date.now() + LEASE_STALE_MS + 1_000,
  });
  try {
    assert.equal(await profileLeaseExists(directory), true);
  } finally {
    await lease.release();
  }
});

test('cleans up its own lease directory when the first owner write fails', async (context) => {
  const directory = await profile(context);
  await assert.rejects(
    acquireProfileLease(directory, {
      hostname: 'host',
      heartbeatMs: 1_000,
      rename: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); },
    }),
    /Cannot create the profile lease/i,
  );
  assert.equal(await exists(leaseDir(directory)), false);
});

test('updates the owner heartbeat and refreshes the lease directory mtime', async (context) => {
  const directory = await profile(context);
  const lease = await acquireProfileLease(directory, {
    hostname: 'host',
    heartbeatMs: 10,
  });
  try {
    const first = JSON.parse(await fs.promises.readFile(ownerFile(directory), 'utf8'));
    const firstMtime = (await fs.promises.lstat(leaseDir(directory))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 35));
    const second = JSON.parse(await fs.promises.readFile(ownerFile(directory), 'utf8'));
    const secondMtime = (await fs.promises.lstat(leaseDir(directory))).mtimeMs;
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.ok(secondMtime >= firstMtime);
  } finally {
    await lease.release();
  }
});

test('reports a lost heartbeat once and still releases the lease', async (context) => {
  const directory = await profile(context);
  let writes = 0;
  let lost = 0;
  const lease = await acquireProfileLease(directory, {
    hostname: 'host',
    heartbeatMs: 5,
    writeFile: async (...args) => {
      writes += 1;
      if (writes > 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.promises.writeFile(...args);
    },
    onLost: () => { lost += 1; },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lost, 1);
  } finally {
    await lease.release();
  }
});

test('reports an unreadable lease with an actionable error', async (context) => {
  const directory = await profile(context);
  await fs.promises.mkdir(leaseDir(directory), { recursive: true });
  await assert.rejects(
    acquireProfileLease(directory, {
      readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    }),
    /EACCES.*permissions/i,
  );
});

test('reports mkdir failures with the lease path', async (context) => {
  const directory = await profile(context);
  await assert.rejects(
    acquireProfileLease(directory, {
      mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    }),
    /Cannot create the profile lease.*EACCES/i,
  );
});

test('releases a lease after a first-migration rejection', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'old-host-123');
  await assert.rejects(
    recoverProfile(directory, {
      hostname: 'new-host',
      pidAlive: () => false,
      heartbeatMs: 1_000,
    }),
    /no prior lease/i,
  );
  assert.equal(await exists(leaseDir(directory)), false);
  assert.equal(await exists(path.join(directory, 'SingletonLock')), true);
});

test('clears a foreign lock after a stale prior lease was taken over', async (context) => {
  const directory = await profile(context);
  const stale = leaseDir(directory);
  await fs.promises.mkdir(stale, { recursive: true });
  await fs.promises.writeFile(ownerFile(directory), JSON.stringify({
    version: 1,
    hostname: 'old-host',
    pid: 100,
    profileDir: directory,
    startedAt: 1,
    updatedAt: 1,
  }));
  await writeLock(directory, 'old-host-123');
  const lease = await recoverProfile(directory, {
    hostname: 'new-host',
    pidAlive: () => false,
    heartbeatMs: 1_000,
    now: () => Date.now() + LEASE_STALE_MS + 1_000,
  });
  try {
    assert.equal(await exists(path.join(directory, 'SingletonLock')), false);
  } finally {
    await lease.release();
  }
});

test('clears a dead same-host lock without a prior lease', async (context) => {
  const directory = await profile(context);
  await writeLock(directory, 'host-123');
  const lease = await recoverProfile(directory, {
    hostname: 'host',
    pidAlive: () => false,
    heartbeatMs: 1_000,
  });
  try {
    assert.equal(await exists(path.join(directory, 'SingletonLock')), false);
  } finally {
    await lease.release();
  }
});
