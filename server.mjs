// server.mjs
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const TICK_MS = 120; // tick rate (ms)
const MAP_SIZE = 50;
const RESPAWN_MS = 1500;

// Bật permessage-deflate với threshold để tránh nén gói nhỏ
const wss = new WebSocketServer({
  port: PORT,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3 }, // mức nén vừa phải
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    threshold: 128 // chỉ nén khi gói tin > 128 byte
  }
});
console.log(`Server listening ws://localhost:${PORT}`);

const players = new Map(); // id -> player
let foods = [];

function randInt(max){ return Math.floor(Math.random()*max); }

function makeId(){
  let id;
  do { id = Math.floor(1 + Math.random()*254); } while (players.has(id));
  return id;
}

function spawnFoodNotColliding(){
  for (let i=0;i<200;i++){
    const x = randInt(MAP_SIZE), y = randInt(MAP_SIZE);
    if (foods.some(f=>f.x===x && f.y===y)) continue;
    let collide = false;
    for (const p of players.values()){
      if (p.snake.some(s=>s.x===x && s.y===y)){ collide = true; break; }
    }
    if (!collide) return {x,y};
  }
  return { x: randInt(MAP_SIZE), y: randInt(MAP_SIZE) };
}

function spawnPlayerSnake(){
  for (let attempts=0; attempts<200; attempts++){
    const x = randInt(MAP_SIZE), y = randInt(MAP_SIZE);
    const dirs = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
    const dir = dirs[randInt(4)];
    const length = 3;
    const snake = [];
    let ok = true;
    for (let i=0;i<length;i++){
      const sx = (x - dir.x*i + MAP_SIZE) % MAP_SIZE;
      const sy = (y - dir.y*i + MAP_SIZE) % MAP_SIZE;
      for (const p of players.values()){
        if (p.snake.some(s=>s.x===sx && s.y===sy)){ ok=false; break; }
      }
      if (!ok) break;
      snake.push({x:sx,y:sy});
    }
    if (ok) return {snake, dir};
  }
  return { snake:[{x:0,y:0}], dir:{x:1,y:0} };
}

wss.on('connection', (ws) => {
  const id = makeId();
  const { snake, dir } = spawnPlayerSnake();
  const player = {
    id,
    ws,
    snake,
    dir,
    pendingDir: null,
    score: 0,
    alive: true,
    respawnAt: 0
  };
  players.set(id, player);

  // ensure enough foods
  while (foods.length < Math.max(1, players.size)) foods.push(spawnFoodNotColliding());

  // send ASSIGN_ID (0x03)
  const assign = Buffer.alloc(2);
  assign.writeUInt8(0x03, 0);
  assign.writeUInt8(id, 1);
  ws.send(assign);

  console.log(`Player ${id} connected (${players.size} players)`);

  ws.on('message', (msg) => {
    // msg is Buffer
    if (msg.length < 2) return;
    const type = msg[0];
    if (type === 0x01) {
      const dir = msg[1];
      const vec = dir === 0 ? {x:0,y:-1}
                : dir === 1 ? {x:0,y:1}
                : dir === 2 ? {x:-1,y:0}
                : {x:1,y:0};
      const p = players.get(id);
      if (!p || !p.alive) return;
      // prevent reversal
      if (p.dir.x + vec.x === 0 && p.dir.y + vec.y === 0) return;
      p.pendingDir = vec;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    // trim foods
    const target = Math.max(1, players.size);
    foods = foods.slice(0, target);
    console.log(`Player ${id} disconnected (${players.size} players)`);
  });
});

// initial food
foods.push(spawnFoodNotColliding());

function tick(){
  const now = Date.now();

  // respawn timers
  for (const p of players.values()){
    if (!p.alive && p.respawnAt && now >= p.respawnAt){
      const { snake, dir } = spawnPlayerSnake();
      p.snake = snake; p.dir = dir; p.pendingDir = null; p.alive = true; p.respawnAt = 0;
      console.log(`Player ${p.id} respawned`);
    }
  }

  // propose moves
  const proposed = new Map();
  for (const p of players.values()){
    if (!p.alive) continue;
    if (p.pendingDir){ p.dir = p.pendingDir; p.pendingDir = null; }
    const head = p.snake[0];
    const nx = (head.x + p.dir.x + MAP_SIZE) % MAP_SIZE;
    const ny = (head.y + p.dir.y + MAP_SIZE) % MAP_SIZE;
    proposed.set(p.id, {x:nx,y:ny});
  }

  // determine who will eat
  const willEat = new Map();
  for (const [id,h] of proposed.entries()){
    willEat.set(id, foods.some(f=>f.x===h.x && f.y===h.y));
  }

  // head-to-head detection
  const headMap = new Map();
  for (const [id,h] of proposed.entries()){
    const key = `${h.x},${h.y}`;
    if (!headMap.has(key)) headMap.set(key, []);
    headMap.get(key).push(id);
  }
  const dead = new Set();
  for (const [k, arr] of headMap.entries()){
    if (arr.length > 1) arr.forEach(id=>dead.add(id));
  }

  // helper collision
  function collidesWithSnakes(px,py, excludeId=null){
    for (const [oid, other] of players.entries()){
      const len = other.snake.length;
      if (len === 0) continue;
      const excludeTail = !willEat.get(oid);
      for (let i=0;i<other.snake.length;i++){
        if (excludeId === oid && i === 0) continue;
        if (excludeTail && i === other.snake.length - 1) continue;
        const s = other.snake[i];
        if (s.x === px && s.y === py) return true;
      }
    }
    return false;
  }

  for (const [id,h] of proposed.entries()){
    if (dead.has(id)) continue;
    if (collidesWithSnakes(h.x,h.y,id)) dead.add(id);
  }

  // apply moves
  for (const [id,p] of players.entries()){
    if (!p.alive) continue;
    if (dead.has(id)){
      p.alive = false;
      p.snake = [];
      p.respawnAt = Date.now() + RESPAWN_MS;
      continue;
    }
    const newHead = proposed.get(id);
    p.snake.unshift(newHead);
    const ate = willEat.get(id);
    if (ate){
      p.score = Math.min(65535, p.score + 1);
      const idx = foods.findIndex(f=>f.x===newHead.x && f.y===newHead.y);
      if (idx !== -1) foods[idx] = spawnFoodNotColliding();
    } else {
      p.snake.pop();
    }
  }

  // ensure food count ~= players
  const targetFood = Math.max(1, players.size);
  while (foods.length < targetFood) foods.push(spawnFoodNotColliding());
  while (foods.length > targetFood) foods.pop();

  // serialize state (0x02)
  let size = 1 + 1; // type + numPlayers
  for (const p of players.values()){
    size += 1 + 2 + 1 + 1; // id + score(u16) + alive + len
    size += p.snake.length * 2;
  }
  size += 1 + foods.length * 2;

  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt8(0x02, off++);               // type
  buf.writeUInt8(players.size, off++);       // numPlayers
  for (const p of players.values()){
    buf.writeUInt8(p.id, off++);
    buf.writeUInt16BE(p.score, off); off += 2;
    buf.writeUInt8(p.alive ? 1 : 0, off++);
    buf.writeUInt8(p.snake.length, off++);
    for (const s of p.snake){ buf.writeUInt8(s.x, off++); buf.writeUInt8(s.y, off++); }
  }
  buf.writeUInt8(foods.length, off++);
  for (const f of foods){ buf.writeUInt8(f.x, off++); buf.writeUInt8(f.y, off++); }

  // broadcast
  for (const client of wss.clients){
    if (client.readyState === 1){
      client.send(buf);
    }
  }
}

setInterval(tick, TICK_MS);
