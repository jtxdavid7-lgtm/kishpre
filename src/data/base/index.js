import { BTN_open_100bb } from './BTN_open_100bb';

export const BASE_RANGES = {
  [BTN_open_100bb.key]: BTN_open_100bb
};

export function getBaseRange(sceneKey) {
  return BASE_RANGES[sceneKey];
}
