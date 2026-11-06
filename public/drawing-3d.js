import {
  Scene,
  Group,
  PerspectiveCamera,
  WebGLRenderer,
  HemisphereLight,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  CylinderGeometry,
  Box3,
  Vector3,
  Vector2,
  Raycaster,
  LoadingManager,
  MathUtils,
  GLTFLoader,
  DRACOLoader,
  MeshoptDecoder,
  OrbitControls,
} from './vendor/three-folio.js';

const degrees = MathUtils.radToDeg,
  radians = MathUtils.degToRad;
const poses = {
  idle: { lShoulder: [0, 0, -12], rShoulder: [0, 0, 12], lElbow: [-8, 0, 0], rElbow: [-8, 0, 0] },
  walk: {
    lHip: [-25, 4, 0],
    rHip: [23, -3, 0],
    lKnee: [4, 0, 0],
    rKnee: [36, 0, 0],
    lShoulder: [20, 0, -9],
    rShoulder: [-28, 0, 7],
    rElbow: [-34, 0, 0],
    spine: [5, 10, 1],
  },
  reach: {
    lShoulder: [-34, 0, -133],
    lElbow: [-30, 0, -14],
    rShoulder: [-10, 0, 21],
    rElbow: [-55, 0, 0],
    neck: [-13, -22, -8],
    spine: [-6, -13, 6],
    lHip: [2, 0, 10],
    rKnee: [12, 0, 0],
  },
  sit: {
    lHip: [-80, 0, -5],
    rHip: [-82, 0, 8],
    lKnee: [90, 0, 0],
    rKnee: [92, 0, 0],
    lShoulder: [-27, 0, -5],
    rShoulder: [-27, 0, 5],
    lElbow: [-55, 0, 0],
    rElbow: [-55, 0, 0],
    spine: [5, 0, 0],
  },
};

function mannequin() {
  const root = new Group(),
    joints = [];
  const porcelain = new MeshStandardMaterial({ color: 0xd8cfbf, roughness: 0.62 });
  const hinges = new MeshStandardMaterial({ color: 0x656778, roughness: 0.48, metalness: 0.22 });
  const eyeMaterial = new MeshStandardMaterial({ color: 0x444650, roughness: 0.65 });
  const orb = new SphereGeometry(1, 32, 20);
  function ellipsoid(parent, x, y, z, sx, sy, sz, material = porcelain) {
    const m = new Mesh(orb, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  }
  function joint(parent, id, name, x, y, z, r) {
    const group = new Group();
    group.position.set(x, y, z);
    group.userData.joint = id;
    parent.add(group);
    joints.push({ id, name, node: group });
    if (r) ellipsoid(group, 0, 0, 0, r, r, r, hinges);
    return group;
  }
  function limb(parent, length, top, bottom) {
    const mesh = new Mesh(new CylinderGeometry(top, bottom, length * 0.82, 26), porcelain);
    mesh.position.y = -length / 2;
    parent.add(mesh);
    ellipsoid(parent, 0, -length * 0.1, 0, top, top * 0.63, top);
    ellipsoid(parent, 0, -length * 0.9, 0, bottom, bottom * 0.62, bottom);
  }
  const pelvis = joint(root, 'pelvis', '骨盆', 0, 0.92, 0, 0);
  ellipsoid(pelvis, 0, 0.015, 0, 0.215, 0.16, 0.145);
  const spine = joint(pelvis, 'spine', '胸腔', 0, 0.12, 0, 0.1);
  ellipsoid(spine, 0, 0.195, 0, 0.235, 0.235, 0.145);
  const neck = joint(spine, 'neck', '头颈', 0, 0.42, 0, 0.065);
  ellipsoid(neck, 0, 0.15, 0.012, 0.131, 0.175, 0.123);
  ellipsoid(neck, 0, 0.145, 0.125, 0.036, 0.035, 0.035);
  for (const sign of [-1, 1]) {
    const left = sign === -1,
      s = left ? 'l' : 'r',
      title = left ? '左' : '右';
    ellipsoid(neck, sign * 0.05, 0.177, 0.121, 0.014, 0.008, 0.009, eyeMaterial);
    const shoulder = joint(spine, s + 'Shoulder', title + '肩', sign * 0.244, 0.32, 0, 0.072);
    limb(shoulder, 0.3, 0.074, 0.052);
    const elbow = joint(shoulder, s + 'Elbow', title + '肘', 0, -0.3, 0, 0.052);
    limb(elbow, 0.255, 0.058, 0.038);
    const wrist = joint(elbow, s + 'Wrist', title + '腕', 0, -0.255, 0, 0.04);
    ellipsoid(wrist, 0, -0.073, 0.013, 0.055, 0.085, 0.035);
    const hip = joint(pelvis, s + 'Hip', title + '髋', sign * 0.126, -0.045, 0, 0.085);
    limb(hip, 0.405, 0.101, 0.073);
    const knee = joint(hip, s + 'Knee', title + '膝', 0, -0.405, 0, 0.064);
    limb(knee, 0.39, 0.077, 0.048);
    const ankle = joint(knee, s + 'Ankle', title + '踝', 0, -0.39, 0, 0.05);
    ellipsoid(ankle, 0, -0.045, 0.06, 0.07, 0.051, 0.129);
  }
  return { root, joints };
}

function freeObject(root) {
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set();
  root?.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    for (const material of [].concat(o.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    o.skeleton?.dispose();
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    texture.source?.data?.close?.();
    texture.dispose();
  }
}

async function glbObject(file, renderer) {
  if (!file || file.size > 48 * 1024 * 1024) throw Error('请选择 48 MB 以内的单文件 GLB。');
  const data = await file.arrayBuffer(),
    header = new DataView(data);
  if (data.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2)
    throw Error('请选择 glTF 2.0 二进制 GLB 文件。');
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data:|blob:)/i.test(url)) return url;
    throw Error('GLB 引用了外部文件，请将贴图和网格嵌入同一个 GLB 后导入。');
  });
  const draco = new DRACOLoader()
    .setDecoderPath(new URL('./vendor/draco/', import.meta.url).href)
    .setWorkerLimit(2);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  try {
    const asset = await loader.parseAsync(data, '');
    const object = asset.scene;
    const box = new Box3().setFromObject(object, true),
      size = box.getSize(new Vector3()),
      center = box.getCenter(new Vector3());
    if (box.isEmpty() || !Number.isFinite(size.length()) || !size.length()) {
      freeObject(object);
      throw Error('没有找到可显示的三维网格。');
    }
    const root = new Group();
    const pivot = new Group();
    pivot.add(object);
    pivot.position.set(-center.x, -box.min.y, -center.z);
    root.add(pivot);
    root.scale.setScalar(1.9 / Math.max(size.x, size.y, size.z));
    const joints = [];
    object.traverse((o) => {
      if (o.isBone) {
        const id = 'bone-' + joints.length;
        o.userData.joint = id;
        joints.push({ id, name: o.name || '关节 ' + (joints.length + 1), node: o });
      }
    });
    return { root, joints };
  } finally {
    draco.dispose();
  }
}

export async function editThreeLayer({ width, height, previous, onSave }) {
  let renderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    throw Error('浏览器未能创建 WebGL 2 画布，请启用硬件加速后重试。');
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'folio-draw fd-three';
  dialog.setAttribute('aria-label', '三维姿势与模型');
  dialog.innerHTML =
    '<header><div><small>FOLIO　/　FIGURE STUDY</small><h2>三维形体室</h2></div><button data-3d="close" aria-label="关闭三维形体室">×</button></header>' +
    '<div class="fd-three-body"><div class="fd-three-stage"></div><aside><small>SUBJECT</small><div class="fd-three-name">木制人偶</div>' +
    '<button data-3d="glb">导入 GLB</button><input type="file" accept=".glb,model/gltf-binary" hidden>' +
    '<label class="fd-preset">姿态<select aria-label="姿态预设"><option value="idle">自然站立</option><option value="walk">迈步</option><option value="reach">抬手</option><option value="sit">坐姿</option></select></label>' +
    '<div class="fd-angles"><small>ARTICULATION</small><label>关节<select class="fd-joint" aria-label="三维关节"></select></label></div>' +
    '<small>CAMERA</small><div class="fd-views"><button data-3d="front">正面</button><button data-3d="side">侧面</button><button data-3d="back">背面</button><button data-3d="home">复位</button></div>' +
    '</aside></div><footer><div><span class="fd-format">3D　/　透视视图</span><p class="fd-hint" role="status">拖动旋转，滚轮缩放，按住 Shift 拖动平移。</p></div>' +
    '<button data-3d="apply" class="fd-apply">应用三维图层 ↗</button></footer>';
  document.body.append(dialog);
  const $ = (q) => dialog.querySelector(q),
    stage = $('.fd-three-stage'),
    angles = $('.fd-angles'),
    selector = $('.fd-joint'),
    hint = $('.fd-hint');
  for (const [axis, label] of [
    ['x', '俯仰'],
    ['y', '转向'],
    ['z', '侧倾'],
  ]) {
    const row = document.createElement('label');
    row.innerHTML =
      label +
      ' <output></output><input type="range" min="-180" max="180" value="0" data-axis="' +
      axis +
      '" aria-label="' +
      label +
      '">';
    angles.append(row);
  }
  const scene = new Scene(),
    camera = new PerspectiveCamera(32, width / height, 0.01, 100);
  scene.add(new HemisphereLight(0xfff5e1, 0xabb7d4, 2));
  const key = new DirectionalLight(0xfff6e6, 2.2),
    rim = new DirectionalLight(0xb9cbff, 1.5);
  key.position.set(-3, 4, 3);
  rim.position.set(3, 3, -2);
  scene.add(key, rim);
  renderer.setClearColor(0xffffff, 0);
  stage.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '三维模型预览');
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.minDistance = 0.25;
  orbit.maxDistance = 15;
  orbit.enableDamping = false;
  const fitDistance = 3.9 * Math.max(1, 0.62 / (width / height));
  const render = () => {
    if (dialog.open) renderer.render(scene, camera);
  };
  orbit.addEventListener('change', render);
  const sizePreview = () => {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const k = Math.min((stage.clientWidth - 8) / width, (stage.clientHeight - 8) / height, 1);
    const rw = Math.max(1, Math.floor(width * k)),
      rh = Math.max(1, Math.floor(height * k));
    const ratio = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(rw, rh);
    render();
  };
  const watcher = new ResizeObserver(sizePreview);
  watcher.observe(stage);
  let current,
    modelFile = null,
    origins = new Map(),
    sequence = 0,
    loading = false;
  function home(angle = 0.13) {
    orbit.target.set(0, 0.94, 0);
    camera.position.set(Math.sin(angle) * fitDistance, 1.03, Math.cos(angle) * fitDistance);
    orbit.update();
  }
  function sliders() {
    const joint = current?.joints.find((j) => j.id === selector.value),
      origin = joint && origins.get(joint.id);
    angles.hidden = !joint;
    if (!joint) return;
    angles.querySelectorAll('input').forEach((input) => {
      const axis = input.dataset.axis;
      input.value = Math.round(degrees(joint.node.rotation[axis] - origin[axis]));
      input.previousElementSibling.textContent = input.value + '°';
    });
  }
  function pose(values = {}) {
    for (const joint of current.joints) {
      const base = origins.get(joint.id),
        delta = values[joint.id] || [0, 0, 0];
      joint.node.rotation.set(
        base.x + radians(delta[0]),
        base.y + radians(delta[1]),
        base.z + radians(delta[2]),
        base.order,
      );
    }
    sliders();
    render();
  }
  function setSubject(object, file = null, old = null) {
    if (current) {
      scene.remove(current.root);
      freeObject(current.root);
    }
    current = object;
    modelFile = file;
    scene.add(current.root);
    origins = new Map(current.joints.map((j) => [j.id, j.node.rotation.clone()]));
    selector.replaceChildren();
    for (const joint of current.joints) {
      const option = document.createElement('option');
      option.value = joint.id;
      option.textContent = joint.name;
      selector.append(option);
    }
    if (old?.joint && current.joints.some((j) => j.id === old.joint)) selector.value = old.joint;
    else if (!file) selector.value = 'lShoulder';
    $('.fd-preset').hidden = Boolean(file);
    $('.fd-three-name').textContent = file?.name || '木制人偶';
    $('.fd-preset select').value = old?.preset || 'idle';
    pose(old?.angles || (file ? {} : poses.idle));
    if (old?.camera && old.target) {
      camera.position.fromArray(old.camera);
      orbit.target.fromArray(old.target);
      orbit.update();
    } else home();
    render();
  }
  async function load(file, old) {
    const seq = ++sequence;
    loading = true;
    hint.textContent = '正在读取本地 GLB…';
    $('[data-3d=apply]').disabled = true;
    try {
      const obj = await glbObject(file, renderer);
      if (seq !== sequence || !dialog.open) {
        freeObject(obj.root);
        return;
      }
      setSubject(obj, file, old);
      hint.textContent = '模型已载入。拖动旋转，滚轮缩放。';
    } catch (error) {
      if (seq === sequence && dialog.open)
        hint.textContent =
          String(error.message).includes('ktx2') || String(error.message).includes('KTX2')
            ? '此 GLB 使用 KTX2 纹理，请转为内嵌 PNG / JPEG 后导入。'
            : '无法导入 GLB。' + String(error.message).slice(0, 150);
    } finally {
      if (seq === sequence && dialog.open) {
        loading = false;
        $('[data-3d=apply]').disabled = false;
      }
    }
  }
  const fileInput = $('[type=file]');
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) load(file);
  };
  selector.onchange = sliders;
  $('.fd-preset select').onchange = (e) => pose(poses[e.target.value]);
  angles.oninput = (e) => {
    const axis = e.target.dataset.axis,
      joint = current?.joints.find((j) => j.id === selector.value);
    if (!axis || !joint) return;
    joint.node.rotation[axis] = origins.get(joint.id)[axis] + radians(Number(e.target.value));
    e.target.previousElementSibling.textContent = e.target.value + '°';
    render();
  };
  let clickStart = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    clickStart = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (
      !clickStart ||
      Math.hypot(e.clientX - clickStart[0], e.clientY - clickStart[1]) > 4 ||
      !current ||
      modelFile
    )
      return;
    const r = renderer.domElement.getBoundingClientRect(),
      pointer = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    const ray = new Raycaster();
    ray.setFromCamera(pointer, camera);
    let obj = ray.intersectObject(current.root, true)[0]?.object;
    while (obj && !obj.userData.joint) obj = obj.parent;
    if (obj) {
      selector.value = obj.userData.joint;
      sliders();
    }
  });
  dialog.onclick = async (e) => {
    const action = e.target.closest('[data-3d]')?.dataset['3d'];
    if (!action) return;
    if (action === 'close') return dialog.close();
    if (action === 'glb') return fileInput.click();
    if (action === 'home' || action === 'front' || action === 'side' || action === 'back')
      return home({ front: 0, side: Math.PI / 2, back: Math.PI }[action] ?? 0.13);
    if (action === 'apply' && current && !loading) {
      try {
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        renderer.render(scene, camera);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(renderer.domElement, 0, 0);
        const values = {};
        for (const j of current.joints) {
          const b = origins.get(j.id);
          values[j.id] = ['x', 'y', 'z'].map((a) => degrees(j.node.rotation[a] - b[a]));
        }
        const scene3d = {
          file: modelFile,
          angles: values,
          camera: camera.position.toArray(),
          target: orbit.target.toArray(),
          joint: selector.value,
          preset: $('.fd-preset select').value,
        };
        await onSave({ canvas, scene3d, name: modelFile?.name || '三维人偶' });
        dialog.close();
      } catch (error) {
        hint.textContent = error.message;
        sizePreview();
      }
    }
  };
  dialog.addEventListener(
    'close',
    () => {
      sequence++;
      watcher.disconnect();
      orbit.dispose();
      freeObject(current?.root);
      renderer.dispose();
      renderer.forceContextLoss();
      dialog.remove();
    },
    { once: true },
  );
  dialog.showModal();
  setSubject(mannequin(), null, previous?.file ? null : previous);
  sizePreview();
  if (previous?.file) await load(previous.file, previous);
}
