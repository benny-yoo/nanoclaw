import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_PREFIXES = ['OPENCODE_', 'OPENAI_', 'OPENROUTER_', 'LITELLM_'];
const PASSTHROUGH_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

registerProviderContainerConfig('opencode', ({ sessionDir, hostEnv }) => {
  const xdgRootHost = path.join(sessionDir, 'opencode-xdg');
  const dataHost = path.join(xdgRootHost, 'data');
  const configHost = path.join(xdgRootHost, 'config');
  const cacheHost = path.join(xdgRootHost, 'cache');

  fs.mkdirSync(dataHost, { recursive: true });
  fs.mkdirSync(configHost, { recursive: true });
  fs.mkdirSync(cacheHost, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/workspace/opencode-xdg/data',
    XDG_CONFIG_HOME: '/workspace/opencode-xdg/config',
    XDG_CACHE_HOME: '/workspace/opencode-xdg/cache',
  };

  for (const [key, value] of Object.entries(hostEnv)) {
    if (!value) continue;
    if (PASSTHROUGH_KEYS.includes(key) || PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }

  return {
    mounts: [{ hostPath: xdgRootHost, containerPath: '/workspace/opencode-xdg', readonly: false }],
    env,
  };
});
