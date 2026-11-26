import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.clipPlanes = []; // 所有材質共用（剖面）
    this.cmapTex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.labels = new THREE.Group();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(300, -300, 250);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(1, -1.5, 2);
    this.camera.add(dl);
    this.scene.add(this.camera);

    this.grid = new THREE.GridHelper(400, 20, 0x5a6573, 0x3a424d);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(40);
    this.scene.add(this.axes);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    this.scene.add(this.labels);
    this.meshes = new Map(); // partId -> { mesh, edges }

    this.hoverMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.45, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.hoverMesh.renderOrder = 2;
    this.scene.add(this.hoverMesh);

    this.raycaster = new THREE.Raycaster();
    this.onPick = null;
    this.onHover = null;
    this._down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this._down = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]);
      this._down = null;
      if (moved < 4 && e.button === 0 && this.onPick) this.onPick(this.pick(e), e);
    });
    el.addEventListener('pointermove', (e) => { if (!this._down && this.onHover) this.onHover(this.pick(e), e); });
    el.addEventListener('pointerleave', () => this.onHover && this.onHover(null));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.onFrame?.();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setParts(parts) {
    for (const { mesh, edges } of this.meshes.values()) {
      this.group.remove(mesh, edges);
      edges.geometry.dispose();
    }
    this.meshes.clear();
    for (const p of parts) {
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: true,
        clippingPlanes: this.clipPlanes,
      });
      const mesh = new THREE.Mesh(p.geometry, mat);
      mesh.userData.partId = p.id;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(p.geometry, 25),
        new THREE.LineBasicMaterial({ color: 0x1b2028, transparent: true, opacity: 0.6, clippingPlanes: this.clipPlanes }),
      );
      this.group.add(mesh, edges);
      this.meshes.set(p.id, { mesh, edges });
    }
  }

  /** 結果網格（每個零件一個，索引或非索引幾何） */
  setResultMeshes(list) {
    this.clearResultMeshes();
    this.resultGroup = new THREE.Group();
    for (const r of list) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.positions.slice(), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((r.positions.length / 3) * 2).fill(0.5), 2));
      if (r.index) g.setIndex(new THREE.BufferAttribute(r.index, 1));
      const mesh = new THREE.Mesh(g, this.resultMaterial());
      mesh.userData = { partId: r.partId, result: true };
      this.resultGroup.add(mesh);
      r.mesh = mesh;
    }
    this.scene.add(this.resultGroup);
  }

  clearResultMeshes() {
    if (!this.resultGroup) return;
    this.resultGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.scene.remove(this.resultGroup);
    this.resultGroup = null;
  }

  showResult(on) {
    if (this.resultGroup) this.resultGroup.visible = on;
    this.group.visible = !on;
  }

  /** 網格線（節點對 → 線段），可帶變形 */
  setWire(segments) {
    if (this.wire) { this.scene.remove(this.wire); this.wire.geometry.dispose(); this.wire = null; }
    if (!segments) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segments, 3));
    this.wire = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.55, clippingPlanes: this.clipPlanes }));
    this.wire.renderOrder = 3;
    this.scene.add(this.wire);
  }

  resultMaterial(clip = true) {
    return new THREE.MeshStandardMaterial({
      map: this.cmapTex, roughness: 0.65, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      clippingPlanes: clip ? this.clipPlanes : [],
    });
  }

  /**
   * 色帶貼圖：u ∈ [0, 1] 對應色帶；u < 0 → 灰色（未計算）
   * colorFn(t) → [r,g,b]（0–1，sRGB）；bands = 0 為連續，否則為分段
   */
  setColormap(colorFn, bands) {
    const W = 512, data = new Uint8Array(W * 4);
    for (let i = 0; i < W; i++) {
      let c;
      if (i < 8) c = [0.42, 0.42, 0.42];
      else {
        let t = (i - 8) / (W - 9);
        if (bands > 0) t = Math.min(bands - 1, Math.floor(t * bands)) / Math.max(1, bands - 1);
        c = colorFn(t);
      }
      data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], 4 * i);
    }
    const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = tex.minFilter = bands > 0 ? THREE.NearestFilter : THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    const old = this.cmapTex;
    this.cmapTex = tex;
    this.scene.traverse((o) => { if (o.material?.map === old) { o.material.map = tex; o.material.needsUpdate = true; } });
    old.dispose();
  }

  /** 數值（已正規化 0–1，或 <0 表示無值）→ 貼圖 u 座標 */
  static texU(t) { return t < 0 ? 4 / 512 : (8.5 + Math.min(1, Math.max(0, t)) * (512 - 9.5)) / 512; }

  /** 剖面：plane = { normal:[x,y,z], constant } 或 null；保留 normal·x + constant ≥ 0 的一側 */
  setClip(plane) {
    const had = this.clipPlanes.length;
    this.clipPlanes.length = 0;
    if (plane) this.clipPlanes.push(new THREE.Plane(new THREE.Vector3(...plane.normal), plane.constant));
    if (had !== this.clipPlanes.length) this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }

  /** 剖切面幾何（位置、uv），不受剖面裁切 */
  setSection(positions, uvs) {
    if (this.section) { this.scene.remove(this.section); this.section.geometry.dispose(); this.section.material.dispose(); this.section = null; }
    if (!positions || !positions.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    const m = new THREE.MeshBasicMaterial({ map: this.cmapTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.section = new THREE.Mesh(g, m);
    this.scene.add(this.section);
  }

  /** 標籤（最大／最小值），以 sprite 顯示並固定螢幕大小 */
  setLabels(list) {
    for (const c of [...this.labels.children]) { this.labels.remove(c); c.material.map?.dispose(); c.material.dispose(); c.geometry?.dispose(); }
    for (const L of list || []) {
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d');
      const font = '600 26px system-ui, sans-serif';
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(L.text).width) + 28;
      cv.width = w; cv.height = 44;
      ctx.font = font;
      ctx.fillStyle = 'rgba(15,18,23,0.88)';
      ctx.beginPath(); ctx.roundRect(0, 0, w, 44, 8); ctx.fill();
      ctx.fillStyle = L.color; ctx.fillRect(0, 0, 6, 44);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(L.text, 16, 23);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
      const scale = 0.026;
      sp.scale.set((scale * w) / 44, scale, 1);
      sp.center.set(-0.06, -0.15);
      sp.position.set(...L.pos);
      sp.renderOrder = 10;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: L.color, depthTest: false }));
      dot.renderOrder = 10;
      dot.onBeforeRender = (r, sc, cam) => { dot.scale.setScalar(dot.position.distanceTo(cam.position) * 0.006); };
      dot.position.set(...L.pos);
      sp.userData.dot = dot;
      this.labels.add(sp);
      this.labels.add(dot);
    }
  }

  moveLabels(list) {
    this.labels.children.forEach((c, i) => { if (list[i]) c.position.set(...list[i]); });
  }

  setHighQuality(on) {
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(on ? Math.min(dpr * 2, 4) : Math.min(dpr, 2));
    this.resize();
  }

  setPartVisible(id, visible, opacity = 1) {
    const m = this.meshes.get(id);
    if (!m) return;
    m.mesh.visible = m.edges.visible = visible;
    m.mesh.material.opacity = opacity;
    m.mesh.material.depthWrite = opacity >= 1;
  }

  setEdgesVisible(v) { for (const { edges, mesh } of this.meshes.values()) edges.visible = v && mesh.visible; }

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const vis = this.resultGroup?.visible
      ? this.resultGroup.children.filter((m) => m.visible)
      : [...this.meshes.values()].map((m) => m.mesh).filter((m) => m.visible);
    const hit = this.raycaster.intersectObjects(vis, false)[0];
    if (!hit) return null;
    return { partId: hit.object.userData.partId, tri: hit.faceIndex, point: hit.point, result: !!hit.object.userData.result, face: hit.face };
  }

  /** 以三角形 soup 顯示 hover 高亮 */
  setHover(positions) {
    const g = this.hoverMesh.geometry;
    if (!positions) { this.hoverMesh.visible = false; return; }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    this.hoverMesh.visible = true;
  }

  clearOverlay() {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  }

  addArrow(origin, dir, length, color) {
    const a = new THREE.ArrowHelper(dir.clone().normalize(), origin.clone().sub(dir.clone().normalize().multiplyScalar(length)), length, color, length * 0.3, length * 0.15);
    this.overlay.add(a);
  }

  addFixMarker(point, size) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(size * 0.5, size, 4), new THREE.MeshBasicMaterial({ color: 0x2f7bff }));
    m.position.copy(point);
    this.overlay.add(m);
  }

  bounds() {
    const box = new THREE.Box3();
    for (const { mesh } of this.meshes.values()) if (mesh.visible) box.expandByObject(mesh);
    if (box.isEmpty()) for (const { mesh } of this.meshes.values()) box.expandByObject(mesh);
    return box;
  }

  fit(dir) {
    const box = this.bounds();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const d = dir ? dir.clone().normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.35;
    this.controls.target.copy(c);
    if (Math.abs(d.z) > 0.999) d.set(0, -0.002, Math.sign(d.z)).normalize(); // 維持 Z 軸朝上
    this.camera.position.copy(c).add(d.multiplyScalar(dist));
    this.camera.near = dist / 100; this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    // 格線置於模型底部
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 2;
    const step = Math.pow(10, Math.floor(Math.log10(size / 4)));
    this.grid.scale.setScalar(size / 400);
    this.grid.position.set(c.x, c.y, box.min.z);
    this.axes.scale.setScalar(Math.max(step, r / 4) / 40);
  }

  refreshEdges(part) {
    const m = this.meshes.get(part.id);
    if (!m) return;
    m.edges.geometry.dispose();
    m.edges.geometry = new THREE.EdgesGeometry(part.geometry, 25);
  }
}
