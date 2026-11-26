import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

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
      });
      const mesh = new THREE.Mesh(p.geometry, mat);
      mesh.userData.partId = p.id;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(p.geometry, 25),
        new THREE.LineBasicMaterial({ color: 0x1b2028, transparent: true, opacity: 0.6 }),
      );
      this.group.add(mesh, edges);
      this.meshes.set(p.id, { mesh, edges });
    }
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
    const vis = [...this.meshes.values()].map((m) => m.mesh).filter((m) => m.visible);
    const hit = this.raycaster.intersectObjects(vis, false)[0];
    if (!hit) return null;
    return { partId: hit.object.userData.partId, tri: hit.faceIndex, point: hit.point };
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
