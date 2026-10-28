import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateAddress } from './policy-proxy.js';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const parseAllowedOrigin = (value, index) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`config.allowedOrigins[${index}] must be a non-empty origin`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`config.allowedOrigins[${index}] is not a valid URL origin`);
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`config.allowedOrigins[${index}] must be an http(s) origin without credentials, path, query, or hash`);
  }
  return url.origin;
};

const parsePorts = (value, label) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}.ports must be a non-empty array`);
  return Object.freeze(value.map((entry, index) => {
    const range = typeof entry === 'string' ? /^(\d+)(?:-(\d+))?$/.exec(entry) : null;
    const [first, last] = range ? [Number(range[1]), Number(range[2] ?? range[1])] : [entry, entry];
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65_535 || first > last) {
      throw new Error(`${label}.ports[${index}] must be a port or a "first-last" range`);
    }
    return Object.freeze([first, last]);
  }));
};

const parseAllowedNetwork = (value, index) => {
  const label = `config.allowedNetworks[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with cidr and ports`);
  }
  const cidr = typeof value.cidr === 'string' ? /^([\d.]+)\/(\d+)$/.exec(value.cidr) : null;
  const prefix = Number(cidr?.[2]);
  if (!cidr || !net.isIPv4(cidr[1]) || prefix < 8 || prefix > 32 || !isPrivateAddress(cidr[1])) {
    throw new Error(`${label}.cidr must be a private or loopback IPv4 block from /8 to /32, such as 192.168.1.0/24`);
  }
  return Object.freeze({ cidr: value.cidr, address: cidr[1], prefix, ports: parsePorts(value.ports, label) });
};

export const extensionRootFrom = (entryUrl) => path.resolve(path.dirname(fileURLToPath(entryUrl)), '..');

export const DEFAULT_SURFACE = Object.freeze({
  quality: 72,
  everyNthFrame: 1,
});

const parseSurface = (value) => {
  if (value === undefined) return DEFAULT_SURFACE;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.surface must be an object');
  }
  const quality = value.quality === undefined ? DEFAULT_SURFACE.quality : value.quality;
  const everyNthFrame = value.everyNthFrame === undefined ? DEFAULT_SURFACE.everyNthFrame : value.everyNthFrame;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error('config.surface.quality must be an integer from 1 to 100');
  }
  if (!Number.isInteger(everyNthFrame) || everyNthFrame < 1 || everyNthFrame > 10) {
    throw new Error('config.surface.everyNthFrame must be an integer from 1 to 10');
  }
  return Object.freeze({ quality, everyNthFrame });
};

export const parseConfig = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json must contain an object');
  }
  const chromePath = value.chromePath;
  if (chromePath !== undefined && (typeof chromePath !== 'string' || chromePath.trim().length === 0)) {
    throw new Error('config.chromePath must be a non-empty string when provided');
  }
  if (value.allowedOrigins !== undefined && !Array.isArray(value.allowedOrigins)) {
    throw new Error('config.allowedOrigins must be an array');
  }
  if (value.allowedNetworks !== undefined && !Array.isArray(value.allowedNetworks)) {
    throw new Error('config.allowedNetworks must be an array');
  }
  if (value.discoverDevServers !== undefined && typeof value.discoverDevServers !== 'boolean') {
    throw new Error('config.discoverDevServers must be true or false');
  }
  const profileRoot = value.profileRoot;
  if (profileRoot !== undefined && profileRoot !== null) {
    if (typeof profileRoot !== 'string' || profileRoot.trim().length === 0) {
      throw new Error('config.profileRoot must be a non-empty absolute path or null');
    }
    if (!path.isAbsolute(profileRoot.trim())) {
      throw new Error('config.profileRoot must be an absolute path');
    }
  }
  const allowedOrigins = (value.allowedOrigins ?? []).map(parseAllowedOrigin);
  return Object.freeze({
    chromePath: chromePath?.trim() ?? null,
    profileRoot: profileRoot?.trim() ?? null,
    surface: parseSurface(value.surface),
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    allowedNetworks: Object.freeze((value.allowedNetworks ?? []).map(parseAllowedNetwork)),
    discoverDevServers: value.discoverDevServers === true,
  });
};

export const loadConfig = ({ entryUrl = import.meta.url, configPath } = {}) => {
  const resolvedPath = configPath ?? path.join(extensionRootFrom(entryUrl), 'config.json');
  let value = {};
  try {
    value = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${resolvedPath}: ${error.message}`);
    if (error?.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ ...parseConfig(value), configPath: resolvedPath });
};

export const originGrants = (allowedOrigins) => allowedOrigins.map((origin) => {
  const url = new URL(origin);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol,
  };
});

export const networkGrants = (allowedNetworks) => allowedNetworks.map(({ address, prefix, ports }) => {
  const block = new net.BlockList();
  block.addSubnet(address, prefix, 'ipv4');
  return { block, ports };
});
