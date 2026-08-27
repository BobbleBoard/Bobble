import { readFileSync } from 'node:fs';
import * as THREE from '/Users/user/Desktop/OSS-harness/node_modules/.pnpm/three@0.180.0/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/Users/user/Desktop/OSS-harness/node_modules/.pnpm/three@0.180.0/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const buf = readFileSync(process.argv[2]);
const loader = new GLTFLoader();
const gltf = await new Promise((res, rej) =>
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej),
);
const root = gltf.scene;
root.updateWorldMatrix(true, true);

for (const name of ['RightArm', 'RightForeArm', 'RightShoulder']) {
  const bone = root.getObjectByName(name);
  if (!bone) {
    console.log(name, 'MISSING');
    continue;
  }
  const kids = bone.children.map(
    (c) => `${c.name || '(unnamed)'}@${c.position.toArray().map((v) => v.toFixed(3))}`,
  );
  const sc = new THREE.Vector3();
  bone.getWorldScale(sc);
  console.log(
    `${name}: type=${bone.type} isBone=${bone.isBone === true} parent=${bone.parent?.name}`,
  );
  console.log(
    `   local pos=${bone.position.toArray().map((v) => v.toFixed(3))} quat=${bone.quaternion.toArray().map((v) => v.toFixed(3))} worldScale=${sc.toArray().map((v) => v.toFixed(3))}`,
  );
  console.log(`   children: ${kids.join(' | ') || 'none'}`);
}

// Now run the aim and report where the limb actually ends up.
const bone = root.getObjectByName('RightArm');
const child = bone.children.find((c) => c.name !== '' && c.position.lengthSq() > 1e-12);
const restDir = child.position.clone().normalize();
const target = new THREE.Vector3(-0.26, 0.96, 0).normalize();
const pq = new THREE.Quaternion();
bone.parent.getWorldQuaternion(pq);
const tLocal = target.clone().applyQuaternion(pq.clone().invert()).normalize();
const restInParent = restDir.clone().applyQuaternion(bone.quaternion).normalize();
const swing = new THREE.Quaternion().setFromUnitVectors(restInParent, tLocal);
const solved = swing.clone().multiply(bone.quaternion);
console.log(`\n restDir(bone frame)=${restDir.toArray().map((v) => v.toFixed(3))}`);
console.log(
  ` restInParent=${restInParent.toArray().map((v) => v.toFixed(3))}  targetInParent=${tLocal.toArray().map((v) => v.toFixed(3))}`,
);
console.log(
  ` swing angle=${((2 * Math.acos(Math.min(1, Math.abs(swing.w))) * 180) / Math.PI).toFixed(1)} deg`,
);

bone.quaternion.copy(solved);
root.updateWorldMatrix(true, true);
const a = new THREE.Vector3(),
  b = new THREE.Vector3();
bone.getWorldPosition(a);
child.getWorldPosition(b);
const got = b.sub(a).normalize();
console.log(
  ` resulting WORLD limb dir=${got.toArray().map((v) => v.toFixed(3))}  (wanted ${target.toArray().map((v) => v.toFixed(3))})  dot=${got.dot(target).toFixed(4)}`,
);
