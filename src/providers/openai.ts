import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_PREFIXES = ['OPENAI_', 'LITELLM_'];
const PASSTHROUGH_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

registerProviderContainerConfig('openai', ({ hostEnv }) => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(hostEnv)) {
    if (!value) continue;
    if (PASSTHROUGH_KEYS.includes(key) || PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }

  return { env };
});
