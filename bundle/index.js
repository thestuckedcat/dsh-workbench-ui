// Host half of the local workbench bundle (@local/dsh-workbench-ui).
//
// The module is a plain Cordis plugin: rc.5 loads this file as the package main
// and applies it with the Host context. All workbench state lives in src/*.mjs;
// this file only wires the rc.5 adapter and the optional composition service.
import {createHostPlugin} from '../src/host-rc5.mjs';

async function loadCompositionAdapter({config, dshHome}) {
  if (config.profile_store === undefined) return undefined;
  try {
    const {createCompositionAdapter} = await import('../src/composition-adapter.mjs');
    return await createCompositionAdapter({config, dshHome});
  } catch {
    // A missing/incomplete composition layer degrades to PROFILE_NOT_FOUND on
    // composition endpoints; it must not take the whole workbench down.
    return undefined;
  }
}

const plugin = createHostPlugin({dynamicCompose: loadCompositionAdapter});

export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
