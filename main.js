/**
 * GunzML — main.js
 * Full-Stack Game Logic: Three.js r128 + Cannon.js 0.6.2
 * ─────────────────────────────────────────────────────
 * Architecture:
 *  CONFIG          — tunable constants
 *  StorageManager  — localStorage persistence layer
 *  NetworkManager  — WebSocket / Socket.io multiplayer
 *  PhysicsManager  — Cannon.js world + sync helpers
 *  PlayerController— movement, sprint, jump, mouse look
 *  BuildingSystem  — grid-snap wall/floor/ramp placement
 *  CombatSystem    — hitscan shooting, damage, reload
 *  AdminSystem     — MCD console, ban/kick
 *  ReportSystem    — player reports → Discord webhook
 *  UIManager       — screens, HUD, toasts, kill feed
 *  Game            — orchestrator, game loop
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   SECTION 1 — CONFIGURATION
   ═══════════════════════════════════════════════════════════ */
const CONFIG = {
  /* --- Server (replace before deploying) --- */
  SERVER_URL:      'ws://localhost:3000',
  DISCORD_WEBHOOK: 'YOUR_DISCORD_WEBHOOK_URL_HERE',

  /* --- Admin --- */
  ADMIN_PASSWORD: 'GunzML@Admin#2024',  // change via admin panel

  /* --- World --- */
  GRAVITY:         -20,
  GRID_SIZE:        4,     // building grid cell size (units)
  GROUND_SIZE:    200,

  /* --- Player Physics --- */
  PLAYER_MASS:     70,
  PLAYER_RADIUS:    0.45,
  PLAYER_HEIGHT:    1.8,

  /* --- Movement --- */
  PLAYER_SPEED:    10,
  SPRINT_MULT:      1.6,
  JUMP_FORCE:      10,

  /* --- Camera --- */
  FOV:             75,
  CAM_DISTANCE:     6,
  CAM_HEIGHT:       2.8,
  CAM_PITCH_MIN:   -0.55,
  CAM_PITCH_MAX:    1.1,
  MOUSE_SENS:       0.002,

  /* --- Combat --- */
  MAX_HEALTH:     100,
  BULLET_DAMAGE:   22,
  HEADSHOT_MULT:    1.8,
  SHOOT_COOLDOWN: 120,  // ms
  RELOAD_TIME:   2200,  // ms
  MAX_AMMO:        30,
  RESERVE_AMMO:   120,
  SHOOT_RANGE:    500,

  /* --- Building --- */
  BUILD_REACH:     18,
  WALL_W: 4, WALL_H: 3.2, WALL_D: 0.35,
  FLOOR_W: 4, FLOOR_H: 0.3, FLOOR_D: 4,
  RAMP_W: 4, RAMP_H: 3.2, RAMP_D: 4,

  /* --- Net --- */
  NET_TICK: 50,   // ms between position broadcasts

  /* --- Misc --- */
  RESPAWN_POS: { x: 0, y: 5, z: 0 },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 2 — SHARED STATE
   ═══════════════════════════════════════════════════════════ */
const State = {
  phase:       'loading', // loading | menu | playing | dead | paused
  playerName:  'Operator',
  localId:     null,
  health:      CONFIG.MAX_HEALTH,
  ammo:        CONFIG.MAX_AMMO,
  reserveAmmo: CONFIG.RESERVE_AMMO,
  kills:       0,
  buildMode:   false,
  buildType:   'wall',  // wall | floor | ramp
  isAdmin:     false,
  players:     {},      // { id: { name, mesh, body, health } }
  structures:  [],      // placed structures
  reports:     [],
  bannedIds:   [],
  config:      {},
};

/* ═══════════════════════════════════════════════════════════
   SECTION 3 — STORAGE MANAGER
   ═══════════════════════════════════════════════════════════ */
const StorageManager = {
  KEY_STATS:    'gunzml_stats',
  KEY_BANS:     'gunzml_bans',
  KEY_REPORTS:  'gunzml_reports',
  KEY_CFG:      'gunzml_cfg',
  KEY_NAME:     'gunzml_playername',

  load() {
    try {
      const cfg      = JSON.parse(localStorage.getItem(this.KEY_CFG)     || '{}');
      const bans     = JSON.parse(localStorage.getItem(this.KEY_BANS)    || '[]');
      const reports  = JSON.parse(localStorage.getItem(this.KEY_REPORTS) || '[]');
      const name     = localStorage.getItem(this.KEY_NAME) || 'Operator';

      State.bannedIds  = bans;
      State.reports    = reports;
      State.config     = cfg;
      State.playerName = name;

      if (cfg.adminPassword) CONFIG.ADMIN_PASSWORD   = cfg.adminPassword;
      if (cfg.discordWebhook) CONFIG.DISCORD_WEBHOOK = cfg.discordWebhook;
      if (cfg.serverUrl)      CONFIG.SERVER_URL       = cfg.serverUrl;
    } catch (e) { console.warn('[Storage] Load failed:', e); }
  },

  saveBans() {
    localStorage.setItem(this.KEY_BANS, JSON.stringify(State.bannedIds));
  },
  saveReports() {
    localStorage.setItem(this.KEY_REPORTS, JSON.stringify(State.reports));
  },
  saveConfig(cfg) {
    State.config = { ...State.config, ...cfg };
    localStorage.setItem(this.KEY_CFG, JSON.stringify(State.config));
  },
  saveName(name) {
    localStorage.setItem(this.KEY_NAME, name);
  },
  saveStats() {
    const s = JSON.parse(localStorage.getItem(this.KEY_STATS) || '{}');
    s.kills = (s.kills || 0) + State.kills;
    localStorage.setItem(this.KEY_STATS, JSON.stringify(s));
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 4 — INPUT MANAGER
   ═══════════════════════════════════════════════════════════ */
const Input = {
  keys:    {},
  mouse:   { dx: 0, dy: 0, lmb: false, rmb: false },
  locked:  false,

  init() {
    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      this._handleSpecial(e);
    });
    document.addEventListener('keyup', e => {
      this.keys[e.code] = false;
    });

    document.addEventListener('mousemove', e => {
      if (this.locked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
    });
    document.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouse.lmb = true;
      if (e.button === 2) this.mouse.rmb = true;
    });
    document.addEventListener('mouseup', e => {
      if (e.button === 0) this.mouse.lmb = false;
      if (e.button === 2) this.mouse.rmb = false;
    });
    document.addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === Game.renderer.domElement;
      if (!this.locked && State.phase === 'playing') {
        UIManager.showPause();
      }
    });
  },

  _handleSpecial(e) {
    // Build mode toggle
    if (e.code === 'KeyB' && State.phase === 'playing') {
      BuildingSystem.toggle();
    }
    // Build type keys
    if (State.buildMode && State.phase === 'playing') {
      if (e.code === 'Digit1') BuildingSystem.setType('wall');
      if (e.code === 'Digit2') BuildingSystem.setType('floor');
      if (e.code === 'Digit3') BuildingSystem.setType('ramp');
    }
    // Reload
    if (e.code === 'KeyR' && State.phase === 'playing') {
      CombatSystem.startReload();
    }
    // Pause
    if (e.code === 'Escape') {
      if (State.phase === 'playing') UIManager.showPause();
      else if (State.phase === 'paused') UIManager.resumeGame();
    }
    // Player list
    if (e.code === 'Tab') {
      e.preventDefault();
      UIManager.togglePlayerList(true);
    }
    // Admin console: Shift + ` (Backquote)
    if (e.shiftKey && e.code === 'Backquote') {
      AdminSystem.toggleConsole();
    }
  },

  consumeMouse() {
    const d = { ...this.mouse };
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return d;
  },

  requestPointerLock() {
    Game.renderer.domElement.requestPointerLock();
  },

  releasePointerLock() {
    document.exitPointerLock();
  },
};

document.addEventListener('keyup', e => {
  if (e.code === 'Tab') UIManager.togglePlayerList(false);
});

/* ═══════════════════════════════════════════════════════════
   SECTION 5 — PHYSICS MANAGER
   ═══════════════════════════════════════════════════════════ */
const PhysicsManager = {
  world:       null,
  bodies:      [],   // { body, mesh } pairs to sync
  groundMat:   null,
  playerMat:   null,
  buildMat:    null,

  init() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, CONFIG.GRAVITY, 0);
    this.world.broadphase    = new CANNON.NaiveBroadphase();
    this.world.solver.iterations = 10;
    this.world.allowSleep    = true;

    // Materials & contact
    this.groundMat = new CANNON.Material('ground');
    this.playerMat = new CANNON.Material('player');
    this.buildMat  = new CANNON.Material('build');

    const groundPlayer = new CANNON.ContactMaterial(
      this.groundMat, this.playerMat,
      { friction: 0.4, restitution: 0.0 }
    );
    const buildPlayer = new CANNON.ContactMaterial(
      this.buildMat, this.playerMat,
      { friction: 0.3, restitution: 0.0 }
    );
    this.world.addContactMaterial(groundPlayer);
    this.world.addContactMaterial(buildPlayer);

    // Ground body
    const groundShape = new CANNON.Plane();
    const groundBody  = new CANNON.Body({ mass: 0, material: this.groundMat });
    groundBody.addShape(groundShape);
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1,0,0), -Math.PI/2);
    this.world.addBody(groundBody);
  },

  step(dt) {
    this.world.step(1/60, dt, 3);
    // Sync meshes to physics bodies
    for (const pair of this.bodies) {
      if (!pair.body || !pair.mesh) continue;
      pair.mesh.position.copy(pair.body.position);
      pair.mesh.quaternion.copy(pair.body.quaternion);
    }
  },

  addBody(body, mesh) {
    this.bodies.push({ body, mesh });
  },

  removeBody(body, mesh) {
    this.world.remove(body);
    this.bodies = this.bodies.filter(p => p.body !== body);
    if (mesh && mesh.parent) mesh.parent.remove(mesh);
  },

  createBoxBody(options) {
    const { w, h, d, mass, position, material } = options;
    const shape = new CANNON.Box(new CANNON.Vec3(w/2, h/2, d/2));
    const body  = new CANNON.Body({ mass: mass || 0, material });
    body.addShape(shape);
    if (position) body.position.set(position.x, position.y, position.z);
    this.world.addBody(body);
    return body;
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 6 — PLAYER CONTROLLER
   ═══════════════════════════════════════════════════════════ */
const PlayerController = {
  body:        null,
  mesh:        null,
  camYaw:       0,
  camPitch:     0.3,
  isGrounded:  false,
  canJump:     true,
  shootTimer:   0,
  reloading:   false,

  init(scene) {
    // Physics body (capsule approximated as sphere)
    const shape = new CANNON.Sphere(CONFIG.PLAYER_RADIUS);
    this.body   = new CANNON.Body({
      mass:             CONFIG.PLAYER_MASS,
      material:         PhysicsManager.playerMat,
      linearDamping:    0.9,
      angularDamping:   1.0,
      fixedRotation:    true,
    });
    this.body.addShape(shape);
    this.body.position.set(
      CONFIG.RESPAWN_POS.x,
      CONFIG.RESPAWN_POS.y,
      CONFIG.RESPAWN_POS.z
    );
    PhysicsManager.world.addBody(this.body);

    // Grounded detection via collision events
    this.body.addEventListener('collide', (e) => {
      const contact = e.contact;
      const ny = contact.ni.y; // normal y — positive means something below
      if (Math.abs(ny) > 0.5) {
        this.isGrounded = true;
        this.canJump    = true;
      }
    });

    // Visual mesh (grouped: body + head)
    const geo  = new THREE.BoxGeometry(0.7, 1.4, 0.5);
    const mat  = new THREE.MeshLambertMaterial({ color: 0x2255aa });
    this.mesh  = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;

    const headGeo  = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const headMesh = new THREE.Mesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xd4a96a }));
    headMesh.position.y = 1.05;
    this.mesh.add(headMesh);

    scene.add(this.mesh);
    // Don't add player mesh to physics sync (camera follows instead)
  },

  update(dt) {
    if (State.phase !== 'playing') return;

    // ── Mouse look ──
    const mouse = Input.consumeMouse();
    this.camYaw   -= mouse.dx * CONFIG.MOUSE_SENS;
    this.camPitch -= mouse.dy * CONFIG.MOUSE_SENS;
    this.camPitch  = Math.max(CONFIG.CAM_PITCH_MIN, Math.min(CONFIG.CAM_PITCH_MAX, this.camPitch));

    // ── Movement direction ──
    const sprint = Input.keys['ShiftLeft'] || Input.keys['ShiftRight'];
    const speed  = CONFIG.PLAYER_SPEED * (sprint ? CONFIG.SPRINT_MULT : 1);

    const fwd   = new CANNON.Vec3(
      -Math.sin(this.camYaw),
      0,
      -Math.cos(this.camYaw)
    );
    const right = new CANNON.Vec3(
      Math.cos(this.camYaw),
      0,
      -Math.sin(this.camYaw)
    );

    let moveX = 0, moveZ = 0;
    if (Input.keys['KeyW'] || Input.keys['ArrowUp'])    { moveX += fwd.x;   moveZ += fwd.z; }
    if (Input.keys['KeyS'] || Input.keys['ArrowDown'])  { moveX -= fwd.x;   moveZ -= fwd.z; }
    if (Input.keys['KeyA'] || Input.keys['ArrowLeft'])  { moveX -= right.x; moveZ -= right.z; }
    if (Input.keys['KeyD'] || Input.keys['ArrowRight']) { moveX += right.x; moveZ += right.z; }

    // Normalize diagonal movement
    const len = Math.sqrt(moveX*moveX + moveZ*moveZ);
    if (len > 0) { moveX /= len; moveZ /= len; }

    this.body.velocity.x = moveX * speed;
    this.body.velocity.z = moveZ * speed;

    // ── Jump ──
    if ((Input.keys['Space']) && this.isGrounded && this.canJump) {
      this.body.velocity.y = CONFIG.JUMP_FORCE;
      this.isGrounded = false;
      this.canJump    = false;
      setTimeout(() => { this.canJump = true; }, 350);
    }

    // Reset grounded each frame (re-set on collision)
    this.isGrounded = false;

    // ── Sync mesh to body ──
    const pos = this.body.position;
    this.mesh.position.set(pos.x, pos.y - CONFIG.PLAYER_RADIUS, pos.z);
    this.mesh.rotation.y = this.camYaw;

    // ── Update camera ──
    this._updateCamera();

    // ── Ground clamp safety ──
    if (this.body.position.y < -50) this.respawn();
  },

  _updateCamera() {
    const pos = this.body.position;
    const yaw   = this.camYaw;
    const pitch = this.camPitch;
    const dist  = CONFIG.CAM_DISTANCE;

    Game.camera.position.set(
      pos.x + dist * Math.sin(yaw) * Math.cos(pitch),
      pos.y + CONFIG.CAM_HEIGHT + dist * Math.sin(pitch),
      pos.z + dist * Math.cos(yaw) * Math.cos(pitch)
    );
    Game.camera.lookAt(
      pos.x,
      pos.y + CONFIG.CAM_HEIGHT * 0.5,
      pos.z
    );
  },

  respawn() {
    this.body.position.set(CONFIG.RESPAWN_POS.x, CONFIG.RESPAWN_POS.y, CONFIG.RESPAWN_POS.z);
    this.body.velocity.set(0, 0, 0);
    State.health   = CONFIG.MAX_HEALTH;
    State.ammo     = CONFIG.MAX_AMMO;
    State.phase    = 'playing';
    UIManager.updateHealth();
    UIManager.updateAmmo();
    UIManager.hideScreen('deathScreen');
  },

  takeDamage(amount, attackerName) {
    State.health = Math.max(0, State.health - amount);
    UIManager.updateHealth();
    UIManager.flashDamage();

    if (State.health <= 0) {
      State.phase = 'dead';
      StorageManager.saveStats();
      UIManager.showDeath(attackerName || 'an enemy');
    }
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 7 — BUILDING SYSTEM
   ═══════════════════════════════════════════════════════════ */
const BuildingSystem = {
  ghostMesh:   null,
  ghostMat:    null,
  placements:  [],  // { mesh, body }
  raycaster:   null,
  snapTargets: [],  // meshes to snap against

  init(scene) {
    this.scene     = scene;
    this.raycaster = new THREE.Raycaster();
    this.ghostMat  = new THREE.MeshBasicMaterial({
      color:       0x39ff8f,
      opacity:     0.4,
      transparent: true,
      depthWrite:  false,
    });
  },

  toggle() {
    State.buildMode = !State.buildMode;
    UIManager.toggleBuildBanner(State.buildMode);
    if (!State.buildMode && this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh = null;
    }
  },

  setType(type) {
    State.buildType = type;
    UIManager.updateBuildType(type);
    if (this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh = null;
    }
  },

  _getDims() {
    switch (State.buildType) {
      case 'wall':  return { w: CONFIG.WALL_W,  h: CONFIG.WALL_H,  d: CONFIG.WALL_D  };
      case 'floor': return { w: CONFIG.FLOOR_W, h: CONFIG.FLOOR_H, d: CONFIG.FLOOR_D };
      case 'ramp':  return { w: CONFIG.RAMP_W,  h: CONFIG.RAMP_H,  d: CONFIG.RAMP_D  };
    }
  },

  _getGhostGeo() {
    const { w, h, d } = this._getDims();
    if (State.buildType === 'ramp') {
      // Ramp: custom BufferGeometry
      return this._rampGeometry(w, h, d);
    }
    return new THREE.BoxGeometry(w, h, d);
  },

  _rampGeometry(w, h, d) {
    // Simple wedge: two triangular faces + rectangles
    const geo = new THREE.BufferGeometry();
    const verts = new Float32Array([
      // bottom face
      -w/2,0,-d/2,  w/2,0,-d/2,  w/2,0,d/2,  -w/2,0,d/2,
      // front face (vertical at back)
      -w/2,0,-d/2,  w/2,0,-d/2,  w/2,h,-d/2,  -w/2,h,-d/2,
      // top/slope face
      -w/2,0,d/2,   w/2,0,d/2,   w/2,h,-d/2,  -w/2,h,-d/2,
      // left face
      -w/2,0,-d/2, -w/2,0,d/2, -w/2,h,-d/2,
      // right face
       w/2,0,-d/2,  w/2,h,-d/2, w/2,0,d/2,
    ]);
    const indices = [
      0,1,2, 0,2,3,        // bottom
      4,6,5, 4,7,6,        // back
      8,10,9, 8,11,10,     // slope
      12,14,13,            // left
      15,16,17,            // right
    ];
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  },

  _snapToGrid(pos) {
    const g = CONFIG.GRID_SIZE;
    return new THREE.Vector3(
      Math.round(pos.x / g) * g,
      Math.round(pos.y / g) * g,
      Math.round(pos.z / g) * g,
    );
  },

  update() {
    if (!State.buildMode || State.phase !== 'playing') return;

    // Raycast from camera center into the scene
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), Game.camera);

    // Build target meshes: ground plane + existing structures
    const targets = [Game.groundMesh, ...this.placements.map(p => p.mesh)];
    const hits    = this.raycaster.intersectObjects(targets);

    let placePos = null;
    if (hits.length > 0 && hits[0].distance < CONFIG.BUILD_REACH) {
      placePos = this._snapToGrid(hits[0].point);
    }

    // Show/update ghost
    if (placePos) {
      if (!this.ghostMesh) {
        const geo       = this._getGhostGeo();
        this.ghostMesh  = new THREE.Mesh(geo, this.ghostMat);
        this.ghostMesh.castShadow = false;
        this.scene.add(this.ghostMesh);
      }
      const { h } = this._getDims();
      this.ghostMesh.position.set(placePos.x, placePos.y + h/2, placePos.z);

      // Rotate wall to face player
      if (State.buildType === 'wall') {
        this.ghostMesh.rotation.y = PlayerController.camYaw;
      } else {
        this.ghostMesh.rotation.y = 0;
      }
    } else if (this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh = null;
    }

    // Place on left-click (while in build mode, LMB)
    if (Input.mouse.lmb && placePos) {
      this.place(placePos);
    }
  },

  place(pos) {
    // Throttle placement
    const now = Date.now();
    if (this._lastPlace && now - this._lastPlace < 200) return;
    this._lastPlace = now;

    const { w, h, d } = this._getDims();
    const yaw = State.buildType === 'wall' ? PlayerController.camYaw : 0;

    // Three.js mesh
    let geo;
    if (State.buildType === 'ramp') {
      geo = this._rampGeometry(w, h, d);
    } else {
      geo = new THREE.BoxGeometry(w, h, d);
    }
    const mat  = new THREE.MeshLambertMaterial({
      color: State.buildType === 'wall'  ? 0xddccaa :
             State.buildType === 'floor' ? 0x998877 : 0xbbaa88,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y + h/2, pos.z);
    mesh.rotation.y = yaw;
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // Physics body (use box approximation for ramp too)
    const body = PhysicsManager.createBoxBody({
      w, h, d,
      mass:     0,
      material: PhysicsManager.buildMat,
      position: { x: pos.x, y: pos.y + h/2, z: pos.z },
    });
    if (yaw !== 0) {
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0,1,0), yaw);
    }

    const entry = { mesh, body, type: State.buildType };
    this.placements.push(entry);
    State.structures.push(entry);

    // Broadcast to network
    NetworkManager.sendBuild({
      type: State.buildType,
      x: pos.x, y: pos.y, z: pos.z,
      yaw,
    });
  },

  addRemote(data) {
    // Reconstruct a placed structure from network data
    const fakePos = new THREE.Vector3(data.x, data.y, data.z);
    State.buildType = data.type;
    const savedYaw   = PlayerController.camYaw;
    PlayerController.camYaw = data.yaw || 0;
    this.place(fakePos);
    PlayerController.camYaw = savedYaw;
    State.buildType = State.buildType; // restore
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 8 — COMBAT SYSTEM
   ═══════════════════════════════════════════════════════════ */
const CombatSystem = {
  raycaster:    null,
  lastShot:     0,
  reloading:    false,
  reloadTimer:  null,
  _reloadStart: 0,

  init() {
    this.raycaster = new THREE.Raycaster();
  },

  update() {
    if (State.phase !== 'playing' || this.reloading) return;
    if (State.buildMode) return; // don't shoot in build mode

    if (Input.mouse.lmb) {
      this.tryShoot();
    }

    // Animate reload bar
    if (this.reloading) {
      const prog = (Date.now() - this._reloadStart) / CONFIG.RELOAD_TIME;
      UIManager.setReloadProgress(Math.min(prog, 1));
    }
  },

  tryShoot() {
    const now = Date.now();
    if (now - this.lastShot < CONFIG.SHOOT_COOLDOWN) return;
    if (State.ammo <= 0) {
      this.startReload();
      return;
    }
    this.lastShot = now;
    State.ammo--;
    UIManager.updateAmmo();

    // Shoot sound (simple oscillator)
    this._playShootSound();

    // Hitscan raycast from camera center
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), Game.camera);

    // Gather all hittable objects
    const targets = [];
    // Remote player meshes
    for (const id in State.players) {
      if (State.players[id].mesh) targets.push(State.players[id].mesh);
    }
    // Structures
    BuildingSystem.placements.forEach(p => targets.push(p.mesh));
    // Ground
    targets.push(Game.groundMesh);

    const hits = this.raycaster.intersectObjects(targets, true);

    if (hits.length > 0) {
      const hit = hits[0];

      // Spawn bullet impact particle
      this._spawnImpact(hit.point);

      // Check if we hit a remote player
      for (const id in State.players) {
        const p = State.players[id];
        if (!p.mesh) continue;
        if (hit.object === p.mesh || p.mesh.children.includes(hit.object)) {
          const isHead = hit.object.position.y > 0.5; // rough headshot check
          const dmg    = Math.round(CONFIG.BULLET_DAMAGE * (isHead ? CONFIG.HEADSHOT_MULT : 1));
          UIManager.showHitMarker();
          NetworkManager.sendHit({ targetId: id, damage: dmg });
          break;
        }
      }
    }

    // Auto-reload when empty
    if (State.ammo <= 0) {
      setTimeout(() => this.startReload(), 400);
    }
  },

  startReload() {
    if (this.reloading || State.reserveAmmo <= 0) return;
    if (State.ammo === CONFIG.MAX_AMMO) return;
    this.reloading     = true;
    this._reloadStart  = Date.now();
    UIManager.showReloadBar(true);

    this.reloadTimer = setTimeout(() => {
      const needed  = CONFIG.MAX_AMMO - State.ammo;
      const take    = Math.min(needed, State.reserveAmmo);
      State.ammo       += take;
      State.reserveAmmo -= take;
      this.reloading     = false;
      UIManager.updateAmmo();
      UIManager.showReloadBar(false);
    }, CONFIG.RELOAD_TIME);
  },

  applyDamage(amount) {
    PlayerController.takeDamage(amount);
  },

  _spawnImpact(point) {
    const geo  = new THREE.SphereGeometry(0.06, 4, 4);
    const mat  = new THREE.MeshBasicMaterial({ color: 0xffaa44 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(point);
    Game.scene.add(mesh);
    setTimeout(() => Game.scene.remove(mesh), 300);
  },

  _playShootSound() {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type      = 'sawtooth';
      osc.frequency.setValueAtTime(180, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (_) { /* audio not supported */ }
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 9 — NETWORK MANAGER
   ═══════════════════════════════════════════════════════════ */
const NetworkManager = {
  socket:    null,
  connected: false,
  _tick:     0,

  init() {
    if (window.__socketStub) {
      console.info('[Net] No Socket.io detected — running offline.');
      return;
    }
    try {
      this.socket = io(CONFIG.SERVER_URL, { transports: ['websocket'], reconnection: true });
      this._bindEvents();
    } catch (e) {
      console.warn('[Net] Connection failed:', e);
    }
  },

  _bindEvents() {
    const s = this.socket;

    s.on('connect', () => {
      this.connected  = true;
      State.localId   = s.id;
      UIManager.setNetStatus(true);
      // Announce ourselves
      s.emit('join', { name: State.playerName, id: s.id });
    });

    s.on('disconnect', () => {
      this.connected = false;
      UIManager.setNetStatus(false);
    });

    // Receive existing room state
    s.on('state', (data) => {
      if (data.players) {
        data.players.forEach(p => {
          if (p.id !== State.localId) this._addRemotePlayer(p);
        });
      }
      if (data.structures) {
        data.structures.forEach(b => BuildingSystem.addRemote(b));
      }
    });

    // Another player joins
    s.on('player_joined', (p) => {
      if (p.id === State.localId) return;
      this._addRemotePlayer(p);
      UIManager.addKillFeed(`${p.name} joined`);
    });

    // Player left
    s.on('player_left', (data) => {
      const p = State.players[data.id];
      if (p) {
        if (p.mesh) Game.scene.remove(p.mesh);
        delete State.players[data.id];
        UIManager.renderPlayerList();
        UIManager.addKillFeed(`${p.name} left`);
      }
    });

    // Position updates from other players
    s.on('player_move', (data) => {
      const p = State.players[data.id];
      if (!p || !p.mesh) return;
      p.mesh.position.set(data.x, data.y, data.z);
      p.mesh.rotation.y = data.ry;
    });

    // Hit received
    s.on('hit', (data) => {
      CombatSystem.applyDamage(data.damage);
    });

    // Kill confirmation
    s.on('kill', (data) => {
      State.kills++;
      UIManager.updateKills();
      UIManager.addKillFeed(`${State.playerName} ↣ ${data.victimName}`);
      UIManager.showHitMarker();
    });

    // Someone placed a building
    s.on('build', (data) => {
      BuildingSystem.addRemote(data);
    });

    // Admin broadcast (kick/ban notification)
    s.on('kicked', (data) => {
      if (data.id === State.localId) {
        UIManager.showToast(`You were kicked: ${data.reason}`, 'error');
        Game.returnToMenu();
      }
    });
  },

  _addRemotePlayer(p) {
    const geo  = new THREE.BoxGeometry(0.7, 1.4, 0.5);
    const mat  = new THREE.MeshLambertMaterial({ color: 0xcc3333 });
    const mesh = new THREE.Mesh(geo, mat);
    const headGeo  = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const head     = new THREE.Mesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xd4a96a }));
    head.position.y = 1.05;
    mesh.add(head);
    if (p.x !== undefined) mesh.position.set(p.x, p.y, p.z);
    Game.scene.add(mesh);

    State.players[p.id] = { name: p.name, mesh, health: CONFIG.MAX_HEALTH };
    UIManager.renderPlayerList();
  },

  // ── Outbound messages ──
  sendMove() {
    if (!this.connected) return;
    const pos = PlayerController.body.position;
    this.socket.emit('move', {
      x:  pos.x, y: pos.y, z: pos.z,
      ry: PlayerController.camYaw,
    });
  },

  sendHit(data) {
    if (!this.connected) return;
    this.socket.emit('hit', data);
  },

  sendBuild(data) {
    if (!this.connected) return;
    this.socket.emit('build', data);
  },

  sendKick(targetId, reason) {
    if (!this.connected) return;
    this.socket.emit('admin_kick', { targetId, reason, adminId: State.localId });
  },

  tick(now) {
    if (!this.connected) return;
    if (now - this._tick > CONFIG.NET_TICK) {
      this._tick = now;
      this.sendMove();
    }
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 10 — ADMIN SYSTEM
   ═══════════════════════════════════════════════════════════ */
const AdminSystem = {
  visible:  false,
  unlocked: false,

  init() {
    const el = document.getElementById('adminConsole');

    document.getElementById('btnAdminAuth').addEventListener('click', () => this.tryAuth());
    document.getElementById('adminPassInput').addEventListener('keydown', e => {
      if (e.code === 'Enter') this.tryAuth();
    });

    document.getElementById('btnAdminClose').addEventListener('click', () => this.hide());
    document.getElementById('btnAdminLock').addEventListener('click',  () => this.lock());

    // Tabs
    document.querySelectorAll('.admin-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(`adminTab-${btn.dataset.tab}`).classList.remove('hidden');

        if (btn.dataset.tab === 'players')  this.renderPlayers();
        if (btn.dataset.tab === 'bans')     this.renderBans();
        if (btn.dataset.tab === 'reports')  this.renderReports();
      });
    });

    document.getElementById('btnAddBan').addEventListener('click', () => this.addBan());
    document.getElementById('btnClearReports').addEventListener('click', () => {
      State.reports = [];
      StorageManager.saveReports();
      this.renderReports();
    });
    document.getElementById('btnSaveConfig').addEventListener('click', () => this.saveConfig());
  },

  toggleConsole() {
    this.visible ? this.hide() : this.show();
  },

  show() {
    this.visible = true;
    document.getElementById('adminConsole').classList.remove('hidden');
    Input.releasePointerLock();
    if (!this.unlocked) {
      document.getElementById('adminPassInput').focus();
    }
    this.renderPlayers();
  },

  hide() {
    this.visible = false;
    document.getElementById('adminConsole').classList.add('hidden');
    if (State.phase === 'playing') Input.requestPointerLock();
  },

  tryAuth() {
    const pass = document.getElementById('adminPassInput').value;
    const msg  = document.getElementById('adminAuthMsg');
    if (pass === CONFIG.ADMIN_PASSWORD) {
      this.unlocked   = true;
      State.isAdmin   = true;
      document.getElementById('adminLock').classList.add('hidden');
      document.getElementById('adminPanel').classList.remove('hidden');
      msg.textContent = '';
      this.renderPlayers();
      this.loadConfig();
    } else {
      msg.textContent = '✕ Incorrect password.';
      msg.className   = 'admin-msg err';
      document.getElementById('adminPassInput').value = '';
    }
  },

  lock() {
    this.unlocked = false;
    State.isAdmin = false;
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('adminLock').classList.remove('hidden');
    document.getElementById('adminPassInput').value = '';
    document.getElementById('adminAuthMsg').textContent = '';
  },

  renderPlayers() {
    const list = document.getElementById('adminPlayerList');
    list.innerHTML = '';

    // Local player
    const localEntry = this._playerEntry(State.localId || 'local', State.playerName + ' (you)', false);
    list.appendChild(localEntry);

    // Remote players
    for (const id in State.players) {
      const p = State.players[id];
      const entry = this._playerEntry(id, p.name, true);
      list.appendChild(entry);
    }

    if (!list.children.length) {
      list.innerHTML = '<p style="color:var(--text-dim);font-size:.75rem;padding:8px 0">No other players online.</p>';
    }
  },

  _playerEntry(id, name, canAction) {
    const div = document.createElement('div');
    div.className = 'admin-entry';
    div.innerHTML = `
      <span class="admin-entry-name">${this._esc(name)}</span>
      <span class="admin-entry-id">${this._esc(id)}</span>
      ${canAction ? `
        <button class="btn-danger" data-action="kick" data-id="${this._esc(id)}" data-name="${this._esc(name)}">KICK</button>
        <button class="btn-danger" data-action="ban"  data-id="${this._esc(id)}" data-name="${this._esc(name)}">BAN</button>
      ` : ''}
    `;
    div.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const pid    = btn.dataset.id;
        const pname  = btn.dataset.name;
        const reason = prompt(`Reason to ${action} ${pname}?`) || 'No reason given';
        if (action === 'kick') this.kickPlayer(pid, pname, reason);
        if (action === 'ban')  this.banPlayer(pid, pname, reason);
      });
    });
    return div;
  },

  kickPlayer(id, name, reason) {
    NetworkManager.sendKick(id, reason);
    UIManager.showToast(`Kicked: ${name}`, 'success');
    this.renderPlayers();
  },

  banPlayer(id, name, reason) {
    if (!State.bannedIds.find(b => b.id === id)) {
      State.bannedIds.push({ id, name, reason, date: new Date().toISOString() });
      StorageManager.saveBans();
    }
    this.kickPlayer(id, name, `Banned: ${reason}`);
    this.renderBans();
  },

  unbanPlayer(id) {
    State.bannedIds = State.bannedIds.filter(b => b.id !== id);
    StorageManager.saveBans();
    this.renderBans();
    UIManager.showToast('Player unbanned.', 'success');
  },

  renderBans() {
    const list = document.getElementById('adminBanList');
    list.innerHTML = '';
    if (!State.bannedIds.length) {
      list.innerHTML = '<p style="color:var(--text-dim);font-size:.75rem;padding:8px 0">No banned players.</p>';
      return;
    }
    State.bannedIds.forEach(b => {
      const div = document.createElement('div');
      div.className = 'admin-entry';
      div.innerHTML = `
        <span class="admin-entry-name">${this._esc(b.name)}</span>
        <span class="admin-entry-id">${this._esc(b.reason)}</span>
        <button class="btn-danger" data-id="${this._esc(b.id)}">UNBAN</button>
      `;
      div.querySelector('[data-id]').addEventListener('click', () => this.unbanPlayer(b.id));
      list.appendChild(div);
    });
  },

  renderReports() {
    const list = document.getElementById('adminReportList');
    list.innerHTML = '';
    if (!State.reports.length) {
      list.innerHTML = '<p style="color:var(--text-dim);font-size:.75rem;padding:8px 0">No reports filed.</p>';
      return;
    }
    State.reports.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'admin-entry';
      div.style.flexDirection = 'column';
      div.style.alignItems    = 'flex-start';
      div.innerHTML = `
        <strong style="color:var(--accent3)">${this._esc(r.reporter)} → ${this._esc(r.target)}</strong>
        <span style="color:var(--text-dim);font-size:.72rem">${this._esc(r.reason)}: ${this._esc(r.details || '')}</span>
        <span style="color:var(--text-dim);font-size:.65rem">${new Date(r.date).toLocaleString()}</span>
      `;
      list.appendChild(div);
    });
  },

  addBan() {
    const id     = document.getElementById('banIdInput').value.trim();
    const reason = document.getElementById('banReasonInput').value.trim();
    if (!id) return;
    this.banPlayer(id, id, reason || 'Manual ban');
    document.getElementById('banIdInput').value     = '';
    document.getElementById('banReasonInput').value = '';
  },

  loadConfig() {
    document.getElementById('cfgServer').value  = CONFIG.SERVER_URL  || '';
    document.getElementById('cfgWebhook').value = CONFIG.DISCORD_WEBHOOK || '';
  },

  saveConfig() {
    const server  = document.getElementById('cfgServer').value.trim();
    const webhook = document.getElementById('cfgWebhook').value.trim();
    const newPass = document.getElementById('cfgNewPass').value.trim();
    const msg     = document.getElementById('cfgMsg');

    const cfg = {};
    if (server)  { CONFIG.SERVER_URL = server;          cfg.serverUrl = server; }
    if (webhook) { CONFIG.DISCORD_WEBHOOK = webhook;    cfg.discordWebhook = webhook; }
    if (newPass) { CONFIG.ADMIN_PASSWORD  = newPass;    cfg.adminPassword  = newPass; }

    StorageManager.saveConfig(cfg);
    msg.textContent = '✓ Configuration saved.';
    msg.className   = 'admin-msg ok';
    document.getElementById('cfgNewPass').value = '';
  },

  _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 11 — REPORT SYSTEM
   ═══════════════════════════════════════════════════════════ */
const ReportSystem = {
  init() {
    document.getElementById('btnReport').addEventListener('click', () => this.openModal());
    document.getElementById('btnSubmitReport').addEventListener('click', () => this.submit());
    document.getElementById('btnCancelReport').addEventListener('click', () => this.closeModal());
  },

  openModal() {
    // Populate player select
    const sel = document.getElementById('reportTarget');
    sel.innerHTML = '<option value="">-- Choose player --</option>';
    for (const id in State.players) {
      const opt = document.createElement('option');
      opt.value       = id;
      opt.textContent = State.players[id].name;
      sel.appendChild(opt);
    }
    document.getElementById('reportModal').classList.remove('hidden');
    if (Input.locked) Input.releasePointerLock();
  },

  closeModal() {
    document.getElementById('reportModal').classList.add('hidden');
    document.getElementById('reportDetails').value = '';
    if (State.phase === 'playing') Input.requestPointerLock();
  },

  async submit() {
    const targetId  = document.getElementById('reportTarget').value;
    const reason    = document.getElementById('reportReason').value;
    const details   = document.getElementById('reportDetails').value.trim();

    if (!targetId) {
      UIManager.showToast('Please select a player to report.', 'error');
      return;
    }

    const target = State.players[targetId];
    const report = {
      reporter: State.playerName,
      target:   target ? target.name : targetId,
      targetId,
      reason,
      details,
      date:    new Date().toISOString(),
    };

    State.reports.push(report);
    StorageManager.saveReports();

    // Send to Discord webhook if configured
    if (CONFIG.DISCORD_WEBHOOK && CONFIG.DISCORD_WEBHOOK !== 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
      await this._sendToDiscord(report);
    }

    this.closeModal();
    UIManager.showToast('Report submitted. Thank you.', 'success');
  },

  async _sendToDiscord(report) {
    try {
      const embed = {
        title:       '⚑ GunzML — Player Report',
        color:       0xff3333,
        fields: [
          { name: 'Reporter',  value: report.reporter, inline: true },
          { name: 'Reported',  value: report.target,   inline: true },
          { name: 'Reason',    value: report.reason,   inline: true },
          { name: 'Details',   value: report.details || 'N/A' },
          { name: 'Timestamp', value: new Date(report.date).toUTCString() },
        ],
      };
      await fetch(CONFIG.DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (e) {
      console.warn('[Report] Discord webhook failed:', e);
    }
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 12 — UI MANAGER
   ═══════════════════════════════════════════════════════════ */
const UIManager = {
  _hitTimeout:    null,
  _damageTimeout: null,

  init() {
    // Main menu buttons
    document.getElementById('btnPlay').addEventListener('click', () => {
      const name = document.getElementById('playerNameInput').value.trim() || 'Operator';
      State.playerName = name;
      StorageManager.saveName(name);
      Game.startGame();
    });
    document.getElementById('btnMultiplayer').addEventListener('click', () => {
      const name = document.getElementById('playerNameInput').value.trim() || 'Operator';
      State.playerName = name;
      StorageManager.saveName(name);
      Game.startGame(true);
    });
    document.getElementById('btnControls').addEventListener('click', () => {
      this.hideScreen('mainMenu');
      this.showScreen('controlsScreen');
    });
    document.getElementById('btnBackControls').addEventListener('click', () => {
      this.hideScreen('controlsScreen');
      this.showScreen('mainMenu');
    });

    // Pause
    document.getElementById('btnResume').addEventListener('click', () => this.resumeGame());
    document.getElementById('btnQuit').addEventListener('click',   () => Game.returnToMenu());

    // Death
    document.getElementById('btnRespawn').addEventListener('click', () => {
      PlayerController.respawn();
      this.hideScreen('deathScreen');
    });
    document.getElementById('btnDeathQuit').addEventListener('click', () => Game.returnToMenu());

    // Pre-fill name
    document.getElementById('playerNameInput').value = State.playerName;

    // Build type click from banner
    document.querySelectorAll('.btype').forEach(el => {
      el.addEventListener('click', () => BuildingSystem.setType(el.dataset.type));
    });
  },

  showScreen(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  },
  hideScreen(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  },

  showHUD(show) {
    const hud = document.getElementById('hud');
    if (show) hud.classList.remove('hidden');
    else      hud.classList.add('hidden');
  },

  showPause() {
    State.phase = 'paused';
    this.showScreen('pauseMenu');
    Input.releasePointerLock();
  },

  resumeGame() {
    State.phase = 'playing';
    this.hideScreen('pauseMenu');
    Input.requestPointerLock();
  },

  showDeath(killerName) {
    document.getElementById('deathMsg').textContent = `Eliminated by ${killerName}.`;
    this.showScreen('deathScreen');
    Input.releasePointerLock();
  },

  updateHealth() {
    const pct = (State.health / CONFIG.MAX_HEALTH) * 100;
    document.getElementById('healthFill').style.width = pct + '%';
    document.getElementById('healthVal').textContent  = State.health;

    const fill = document.getElementById('healthFill');
    if (State.health > 50)      fill.style.background = 'var(--accent2)';
    else if (State.health > 25) fill.style.background = 'var(--accent)';
    else                        fill.style.background = 'var(--danger)';
  },

  updateAmmo() {
    document.getElementById('ammoCount').textContent   = State.ammo;
    document.getElementById('ammoReserve').textContent = State.reserveAmmo;
  },

  updateKills() {
    document.getElementById('killCount').textContent = State.kills;
  },

  showHitMarker() {
    const el = document.getElementById('hitMarker');
    el.classList.remove('hidden');
    clearTimeout(this._hitTimeout);
    this._hitTimeout = setTimeout(() => el.classList.add('hidden'), 250);
  },

  flashDamage() {
    document.body.style.boxShadow = 'inset 0 0 60px rgba(255,0,0,0.4)';
    clearTimeout(this._damageTimeout);
    this._damageTimeout = setTimeout(() => {
      document.body.style.boxShadow = '';
    }, 300);
  },

  addKillFeed(text) {
    const feed = document.getElementById('killFeed');
    const el   = document.createElement('div');
    el.className   = 'kf-entry';
    el.textContent = text;
    feed.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
    // Keep feed max 5 entries
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
  },

  toggleBuildBanner(show) {
    const el = document.getElementById('buildBanner');
    if (show) el.classList.remove('hidden');
    else      el.classList.add('hidden');
    this.updateBuildType(State.buildType);
  },

  updateBuildType(type) {
    document.querySelectorAll('.btype').forEach(el => {
      el.classList.toggle('active', el.dataset.type === type);
    });
  },

  showReloadBar(show) {
    const el = document.getElementById('reloadBar');
    if (show) el.classList.remove('hidden');
    else      el.classList.add('hidden');
    if (!show) this.setReloadProgress(0);
  },

  setReloadProgress(pct) {
    document.getElementById('reloadFill').style.width = (pct * 100) + '%';
  },

  setNetStatus(online) {
    const el = document.getElementById('netStatus');
    el.className   = online ? 'net-online' : 'net-offline';
    el.textContent = online ? `● ONLINE — ${Object.keys(State.players).length + 1} players` : '● OFFLINE';
  },

  renderPlayerList() {
    const ul = document.getElementById('plList');
    ul.innerHTML = '';
    const mkLi = (name, isLocal) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${isLocal ? '▶ ' : ''}${name}</span><span style="color:var(--accent)">0</span>`;
      ul.appendChild(li);
    };
    mkLi(State.playerName, true);
    for (const id in State.players) mkLi(State.players[id].name, false);
    this.setNetStatus(NetworkManager.connected);
  },

  togglePlayerList(show) {
    const el = document.getElementById('playerList');
    if (show) el.classList.remove('hidden');
    else      el.classList.add('hidden');
  },

  showToast(msg, type = '') {
    const container = document.getElementById('toastContainer');
    const el        = document.createElement('div');
    el.className    = `toast ${type}`;
    el.textContent  = msg;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  },

  setLoadProgress(pct, status) {
    document.getElementById('loadBar').style.width  = pct + '%';
    document.getElementById('loadStatus').textContent = status;
  },

  hideLoadingScreen() {
    const el = document.getElementById('loadingScreen');
    el.style.transition = 'opacity 0.5s';
    el.style.opacity    = '0';
    setTimeout(() => el.style.display = 'none', 500);
  },
};

/* ═══════════════════════════════════════════════════════════
   SECTION 13 — GAME ORCHESTRATOR
   ═══════════════════════════════════════════════════════════ */
const Game = {
  scene:      null,
  camera:     null,
  renderer:   null,
  clock:      null,
  groundMesh: null,
  _raf:       null,

  async init() {
    StorageManager.load();

    // ── Renderer ──
    this.renderer = new THREE.WebGLRenderer({
      canvas:    document.getElementById('gameCanvas'),
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });

    UIManager.setLoadProgress(10, 'Setting up scene...');
    await this._delay(80);

    // ── Scene ──
    this.scene  = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.FogExp2(0x87ceeb, 0.012);

    // ── Camera ──
    this.camera = new THREE.PerspectiveCamera(
      CONFIG.FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      500
    );
    this.clock = new THREE.Clock();

    UIManager.setLoadProgress(25, 'Loading lighting...');
    await this._delay(80);
    this._setupLighting();

    UIManager.setLoadProgress(40, 'Building world...');
    await this._delay(80);
    this._setupWorld();

    UIManager.setLoadProgress(60, 'Initializing physics...');
    await this._delay(80);
    PhysicsManager.init();

    UIManager.setLoadProgress(75, 'Loading systems...');
    await this._delay(80);

    BuildingSystem.init(this.scene);
    CombatSystem.init();
    Input.init();

    UIManager.setLoadProgress(90, 'Preparing UI...');
    await this._delay(80);

    UIManager.init();
    AdminSystem.init();
    ReportSystem.init();

    UIManager.setLoadProgress(100, 'Ready!');
    await this._delay(500);
    UIManager.hideLoadingScreen();

    State.phase = 'menu';
    UIManager.showScreen('mainMenu');

    // Start the render loop (even on menu — renders background)
    this._loop();
  },

  _setupLighting() {
    // Ambient
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    // Sun (directional with shadows)
    const sun = new THREE.DirectionalLight(0xfff5dd, 1.2);
    sun.position.set(80, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.width  = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near   =  0.5;
    sun.shadow.camera.far    = 500;
    sun.shadow.camera.left   = -80;
    sun.shadow.camera.right  =  80;
    sun.shadow.camera.top    =  80;
    sun.shadow.camera.bottom = -80;
    this.scene.add(sun);

    // Hemisphere fill
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3d5c2b, 0.4);
    this.scene.add(hemi);
  },

  _setupWorld() {
    // Ground plane
    const groundGeo  = new THREE.PlaneGeometry(CONFIG.GROUND_SIZE, CONFIG.GROUND_SIZE, 32, 32);
    const groundMat  = new THREE.MeshLambertMaterial({ color: 0x4a7c3b });
    this.groundMesh  = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.rotation.x    = -Math.PI / 2;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    // Grid overlay
    const gridHelper = new THREE.GridHelper(CONFIG.GROUND_SIZE, CONFIG.GROUND_SIZE / CONFIG.GRID_SIZE, 0x2a5c2a, 0x2a5c2a);
    gridHelper.position.y = 0.01;
    this.scene.add(gridHelper);

    // Decorative: a few static boxes (terrain variation)
    const boxPositions = [
      [-20, 1, -15], [18, 1.5, -30], [-35, 1, 25], [30, 1, 20],
    ];
    boxPositions.forEach(([x, y, z]) => {
      const w = 3 + Math.random() * 6;
      const h = 2 + Math.random() * 4;
      const d = 3 + Math.random() * 6;
      const geo  = new THREE.BoxGeometry(w, h, d);
      const mat  = new THREE.MeshLambertMaterial({ color: 0x8a7a6a });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, h/2, z);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Physics for terrain boxes
      PhysicsManager.createBoxBody({
        w, h, d,
        mass:     0,
        material: PhysicsManager.buildMat,
        position: { x, y: h/2, z },
      });
    });
  },

  async startGame(connectToServer = false) {
    UIManager.hideScreen('mainMenu');
    UIManager.hideScreen('controlsScreen');

    // Setup player
    PlayerController.init(this.scene);

    // Networking
    if (connectToServer) {
      NetworkManager.init();
    }

    UIManager.showHUD(true);
    State.phase  = 'playing';
    State.health = CONFIG.MAX_HEALTH;
    State.ammo   = CONFIG.MAX_AMMO;
    State.kills  = 0;
    UIManager.updateHealth();
    UIManager.updateAmmo();
    UIManager.updateKills();
    UIManager.renderPlayerList();

    // Request pointer lock
    setTimeout(() => Input.requestPointerLock(), 300);
  },

  returnToMenu() {
    State.phase = 'menu';
    Input.releasePointerLock();
    UIManager.showHUD(false);
    UIManager.hideScreen('pauseMenu');
    UIManager.hideScreen('deathScreen');
    UIManager.showScreen('mainMenu');

    // Remove player from scene
    if (PlayerController.mesh && PlayerController.mesh.parent) {
      this.scene.remove(PlayerController.mesh);
    }
    if (PlayerController.body) {
      PhysicsManager.world.remove(PlayerController.body);
    }

    // Clear remote players
    for (const id in State.players) {
      const p = State.players[id];
      if (p.mesh && p.mesh.parent) this.scene.remove(p.mesh);
    }
    State.players = {};

    // Clear structures
    BuildingSystem.placements.forEach(({ mesh, body }) => {
      this.scene.remove(mesh);
      PhysicsManager.world.remove(body);
    });
    BuildingSystem.placements = [];
    State.structures = [];

    // Disconnect network
    if (NetworkManager.socket) NetworkManager.socket.disconnect();
    NetworkManager.connected = false;
    UIManager.setNetStatus(false);
  },

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const dt  = Math.min(this.clock.getDelta(), 0.05);
    const now = Date.now();

    if (State.phase === 'playing') {
      PhysicsManager.step(dt);
      PlayerController.update(dt);
      BuildingSystem.update();
      CombatSystem.update();
      NetworkManager.tick(now);
    }

    this.renderer.render(this.scene, this.camera);
  },

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },
};

/* ═══════════════════════════════════════════════════════════
   ENTRY POINT
   ═══════════════════════════════════════════════════════════ */
window.addEventListener('load', () => Game.init());
