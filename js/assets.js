import * as THREE from 'three';

/**
 * Foto-Texturen (CC0, Poly Haven) und Himmels-HDRI.
 * Entwicklung: Dateien aus assets/; im gebündelten Spiel (tools/bundle.py) als eingebettete data:-URLs.
 */
const EMBED = /*ASSETS*/null;
const assetUrl = (name) => (EMBED && EMBED[name]) || 'assets/' + name;

const loader = new THREE.TextureLoader();
const cache = new Map();
/** Kachelbare Textur laden (wird asynchron befüllt, ist aber sofort benutzbar). kind: 'diff' | 'nor' | 'rough' */
function photoTex(name, kind) {
  const key = name + '_' + kind;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(assetUrl(`tex/${key}.jpg`));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

export { assetUrl, photoTex };
