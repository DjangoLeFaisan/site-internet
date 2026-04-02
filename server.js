const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- CONSTANTES PHYSIQUES (Arène x2) ---
const FPS = 60;
const frameInterval = 1000 / FPS;
const GRAVITY = 0.5;
const JUMP_FORCE = -11;
const GROUND_ACCEL = 0.9;
const AIR_ACCEL = 0.25;
const MAX_SPEED = 5.5;
const FRICTION = 0.82;
const AIR_FRICTION = 0.98;

const GLOBAL_SPEED_MUL = 1.2;
const GLOBAL_JUMP_MUL = 1.0;

// Arène agrandie x2
const mainStage = { x: 400, y: 410, w: 800, h: 50 };
const platforms = [
    { x: 240, y: 290, w: 260, h: 10 },
    { x: 1100, y: 290, w: 260, h: 10 }
];

// Palette de 8 couleurs bien distinctes
const COLOR_PALETTE = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#9b59b6', '#eccc68', '#70a1ff', '#ff6b81'];

// --- BALANCING COMBAT ---
const ATK_NORM_STARTUP = 4;
const ATK_NORM_ACTIVE = 6;
const ATK_NORM_ENDLAG = 8;
const ATK_NORM_DMG = 8;
const ATK_NORM_KB = 7;
const CHARGE_MAX = 70;
const ATK_CHRG_STARTUP = 3;
const ATK_CHRG_ACTIVE = 10;
const ATK_CHRG_ENDLAG_MIN = 20;
const ATK_CHRG_ENDLAG_MAX = 50;
const ATK_CHRG_DMG_MIN = 10;
const ATK_CHRG_DMG_MAX = 30;
const ATK_CHRG_KB_MIN = 7;
const ATK_CHRG_KB_MAX = 20;
const ATK_CHRG_RANGE_MIN = 42;
const ATK_CHRG_RANGE_MAX = 102;
const PROJ_STARTUP = 8;
const PROJ_ENDLAG = 25;
const PROJ_DMG = 4;
const PROJ_KB = 2;
const PROJ_SPEED_X = 9;
const PROJ_SPEED_Y = -5;

const BONUSES = {
    triple_jump:  { name:'3RD JUMP', maxJumps:3, dmgMul:1.0, spdMul:1.0 },
    damage_boost: { name:'DMG x1.5', maxJumps:2, dmgMul:1.5, spdMul:1.0 },
    speed_boost:  { name:'SPD x1.3', maxJumps:2, dmgMul:1.0, spdMul:1.3 }
};

// --- ETAT DU JEU ---
let gameState = 'WAITING'; 
let players = {}; 
let projectiles = [];
let killcam = { active: false, timer: 0, x: 0, y: 0 };
let gameWinner = null;

// --- GESTION DES CONNEXIONS ---
io.on('connection', (socket) => {
    console.log('Connecté:', socket.id);

    if (gameState !== 'WAITING' || Object.keys(players).length >= 8) {
        players[socket.id] = createFighter(socket.id, 'Spectateur', false);
        players[socket.id].isSpectator = true;
        players[socket.id].stocks = 0;
    } else {
        players[socket.id] = createFighter(socket.id, 'Joueur ' + (Object.keys(players).length + 1), false);
    }

    sendLobbyUpdate();
    socket.emit('state_update', gameState);

    socket.on('update_profile', (data) => {
        if(players[socket.id] && gameState === 'WAITING' && !players[socket.id].isSpectator) {
            players[socket.id].name = data.name;
            players[socket.id].perk = data.perk;
            players[socket.id].ready = data.ready;
            sendLobbyUpdate();
        }
    });

    socket.on('add_bot', () => {
        if (gameState === 'WAITING' && Object.keys(players).length < 8) {
            let botId = 'bot_' + Math.random().toString(36).substr(2, 9);
            const perks = Object.keys(BONUSES);
            players[botId] = createFighter(botId, 'AlphaBot ' + Math.floor(Math.random()*100), true);
            players[botId].perk = perks[Math.floor(Math.random()*perks.length)];
            players[botId].ready = true;
            sendLobbyUpdate();
        }
    });

    // Suppression d'un Bot
    socket.on('remove_bot', (botId) => {
        if (gameState === 'WAITING' && players[botId] && players[botId].isBot) {
            delete players[botId];
            sendLobbyUpdate();
        }
    });

    socket.on('start_game', () => {
        let realPlayers = Object.values(players).filter(p => !p.isBot && !p.isSpectator);
        let allReady = realPlayers.every(p => p.ready);
        let totalFighters = Object.values(players).filter(p => !p.isSpectator).length;
        if (gameState === 'WAITING' && allReady && totalFighters >= 2) {
            startGame();
        }
    });

    socket.on('player_input', (inputs) => {
        if(players[socket.id] && gameState === 'PLAYING') {
            players[socket.id].inputs = inputs;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        sendLobbyUpdate();
        checkGameOver();
    });
});

function createFighter(id, name, isBot) {
    return {
        id, name, isBot, ready: false, perk: 'triple_jump', isSpectator: false,
        x: 800, y: 100, w: 34, h: 54, vx: 0, vy: 0,
        facing: 1, damage: 0, stocks: 3, jumps: 2, hitstun: 0,
        actionState: 'IDLE', actionFrame: 0, isAtk: false, atkType: 'normal',
        chargeFrames: 0, isCharging: false, chargeSnap: 0,
        color: getUniqueColor(),
        kills: 0, lastHitter: null, inputs: {},
        aiState: 'IDLE', aiTimer: 0, aiChargeTarget: 0
    };
}

// Fonction pour attribuer une couleur libre
function getUniqueColor() {
    let usedColors = Object.values(players).map(p => p.color);
    for (const color of COLOR_PALETTE) {
        if (!usedColors.includes(color)) return color;
    }
    return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function sendLobbyUpdate() {
    io.emit('lobby_update', Object.values(players).map(p => ({
        id: p.id, name: p.name, ready: p.ready, perk: p.perk, isBot: p.isBot, color: p.color, isSpectator: p.isSpectator
    })));
}

function startGame() {
    gameState = 'PLAYING';
    projectiles = [];
    killcam = { active: false, timer: 0, x: 0, y: 0 };
    
    let activeList = Object.values(players).filter(p => !p.isSpectator);
    activeList.forEach((p, index) => {
        let bonus = BONUSES[p.perk];
        p.x = mainStage.x + 100 + (index * 70);
        p.y = 100; p.vx = 0; p.vy = 0;
        p.damage = 0; p.stocks = 3; p.kills = 0; p.lastHitter = null;
        p.jumps = bonus.maxJumps;
        p.isCharging = false; p.actionState = 'IDLE';
    });
    
    io.emit('state_update', gameState);
}

// --- BOUCLE DE JEU ---
setInterval(() => {
    if (gameState !== 'PLAYING') return;

    if (killcam.active) {
        killcam.timer--;
        if (killcam.timer <= 0) killcam.active = false;
        io.emit('game_tick', { players: Object.values(players), projectiles, killcam });
        return;
    }

    let activePlayers = Object.values(players).filter(p => p.stocks > 0 && !p.isSpectator);

    activePlayers.forEach(p => { if (p.isBot) runAI(p, activePlayers); });

    activePlayers.forEach(p => {
        let bonus = BONUSES[p.perk];
        p.vy += GRAVITY;

        if (p.hitstun > 0) p.hitstun--;
        else handleFighterActions(p, bonus);

        let isG = onGround(p);
        p.vx *= isG ? FRICTION : AIR_FRICTION;
        
        let isChargedEndlag = (p.actionState === 'ATTACK_CHARGED' && p.actionFrame > ATK_CHRG_STARTUP + ATK_CHRG_ACTIVE);
        if (p.hitstun <= 0 && !isChargedEndlag) {
            let ms = MAX_SPEED * bonus.spdMul * GLOBAL_SPEED_MUL;
            if (p.vx > ms) p.vx = ms;
            if (p.vx < -ms) p.vx = -ms;
        }

        p.x += p.vx;
        p.y += p.vy;

        checkCollisions(p, bonus);
        checkDeath(p);
    });

    for (let i = projectiles.length - 1; i >= 0; i--) {
        const proj = projectiles[i];
        proj.vy += 0.25; proj.x += proj.vx; proj.y += proj.vy;

        activePlayers.forEach(opp => {
            if (proj.owner !== opp.id && proj.x > opp.x && proj.x < opp.x + opp.w && proj.y > opp.y && proj.y < opp.y + opp.h) {
                applyDamage(opp, proj.owner, proj.dmg, proj.kb, proj.vx > 0 ? 1 : -1);
                projectiles.splice(i, 1);
            }
        });
        if (proj.y > 650 || proj.x < -100 || proj.x > 1700) projectiles.splice(i, 1);
    }

    checkGameOver();
    io.emit('game_tick', { players: Object.values(players), projectiles, killcam });

}, frameInterval);

// --- LOGIQUE COMBAT ---
function handleFighterActions(p, bonus) {
    let isG = onGround(p);
    let chargeSlow = p.isCharging ? 0.15 : 1;
    let accel = (isG ? GROUND_ACCEL : AIR_ACCEL) * bonus.spdMul * chargeSlow * GLOBAL_SPEED_MUL;

    if (p.inputs.left) { p.vx -= accel; if (!p.isCharging && p.actionState === 'IDLE') p.facing = -1; }
    if (p.inputs.right) { p.vx += accel; if (!p.isCharging && p.actionState === 'IDLE') p.facing = 1; }
    if (p.inputs.jump && p.jumps > 0) { p.vy = JUMP_FORCE * GLOBAL_JUMP_MUL; p.jumps--; p.inputs.jump = false; }

    if (p.isCharging) p.chargeFrames = Math.min(p.chargeFrames + 1, CHARGE_MAX);
    if (p.inputs.charge && !p.isCharging && p.actionState === 'IDLE') { p.isCharging = true; p.chargeFrames = 0; }
    if (!p.inputs.charge && p.isCharging) {
        p.isCharging = false;
        p.chargeSnap = Math.min(p.chargeFrames / CHARGE_MAX, 1);
        p.actionState = 'ATTACK_CHARGED';
        p.actionFrame = 0;
    }

    if (p.inputs.attack && p.actionState === 'IDLE' && !p.isCharging) { p.actionState = 'ATTACK_NORMAL'; p.actionFrame = 0; }
    if (p.inputs.shoot && p.actionState === 'IDLE' && !p.isCharging) { p.actionState = 'SHOOT'; p.actionFrame = 0; }

    if (p.actionState !== 'IDLE') {
        p.actionFrame++;
        if (p.actionState === 'ATTACK_NORMAL') {
            if (p.actionFrame === ATK_NORM_STARTUP) checkMeleeHit(p, Math.round(ATK_NORM_DMG * bonus.dmgMul), ATK_NORM_KB, 35, 38);
            else if (p.actionFrame >= ATK_NORM_STARTUP + ATK_NORM_ACTIVE + ATK_NORM_ENDLAG) p.actionState = 'IDLE';
        } 
        else if (p.actionState === 'ATTACK_CHARGED') {
            let activeLimit = ATK_CHRG_STARTUP + ATK_CHRG_ACTIVE;
            let endLag = Math.round(ATK_CHRG_ENDLAG_MIN + p.chargeSnap * (ATK_CHRG_ENDLAG_MAX - ATK_CHRG_ENDLAG_MIN));
            if (p.actionFrame === ATK_CHRG_STARTUP) {
                let range = Math.round(ATK_CHRG_RANGE_MIN + p.chargeSnap * (ATK_CHRG_RANGE_MAX - ATK_CHRG_RANGE_MIN));
                let dmg = Math.round(ATK_CHRG_DMG_MIN + p.chargeSnap * (ATK_CHRG_DMG_MAX - ATK_CHRG_DMG_MIN));
                let kb = ATK_CHRG_KB_MIN + p.chargeSnap * (ATK_CHRG_KB_MAX - ATK_CHRG_KB_MIN);
                checkMeleeHit(p, Math.round(dmg * bonus.dmgMul), kb, range, 50);
            } else if (p.actionFrame >= activeLimit + endLag) p.actionState = 'IDLE';
        }
        else if (p.actionState === 'SHOOT') {
            if (p.actionFrame === PROJ_STARTUP) {
                projectiles.push({
                    x: p.x + (p.facing === 1 ? p.w : -14), y: p.y + 15,
                    vx: p.facing * PROJ_SPEED_X, vy: PROJ_SPEED_Y,
                    owner: p.id, color: p.color, dmg: PROJ_DMG, kb: PROJ_KB
                });
            } else if (p.actionFrame >= PROJ_STARTUP + PROJ_ENDLAG) p.actionState = 'IDLE';
        }
    }
}

function onGround(p) {
    if (p.vy >= 0 && p.y + p.h >= mainStage.y && p.y + p.h <= mainStage.y + 15 && p.x + p.w > mainStage.x && p.x < mainStage.x + mainStage.w) return true;
    for (const plat of platforms) if (p.vy >= 0 && p.y + p.h >= plat.y && p.y + p.h <= plat.y + 14 && p.x + p.w > plat.x && p.x < plat.x + plat.w) return true;
    return false;
}

function checkCollisions(p, bonus) {
    if (p.x + p.w > mainStage.x && p.x < mainStage.x + mainStage.w && p.y + p.h > mainStage.y && p.y < mainStage.y + mainStage.h) {
        let ft = Math.abs((p.y + p.h) - mainStage.y);
        let fb = Math.abs(p.y - (mainStage.y + mainStage.h));
        let fl = Math.abs((p.x + p.w) - mainStage.x);
        let fr = Math.abs(p.x - (mainStage.x + mainStage.w));
        let mn = Math.min(ft, fb, fl, fr);
        if (mn === ft && p.vy >= 0) { p.y = mainStage.y - p.h; p.vy = 0; p.jumps = bonus.maxJumps; }
        else if (mn === fb && p.vy < 0) { p.y = mainStage.y + mainStage.h; p.vy = 0.5; }
        else if (mn === fl) { p.x = mainStage.x - p.w; p.vx = 0; }
        else if (mn === fr) { p.x = mainStage.x + mainStage.w; p.vx = 0; }
    }
    for (const plat of platforms) {
        if (p.vy >= 0 && p.y + p.h >= plat.y && p.y + p.h <= plat.y + 14 && p.x + p.w > plat.x && p.x < plat.x + plat.w) {
            p.y = plat.y - p.h; p.vy = 0; p.jumps = bonus.maxJumps;
        }
    }
}

function checkMeleeHit(attacker, dmg, kb, range, height) {
    let hbX = attacker.facing === 1 ? attacker.x + attacker.w : attacker.x - range;
    Object.values(players).forEach(opp => {
        if (opp.stocks > 0 && attacker.id !== opp.id && !opp.isSpectator && hbX < opp.x + opp.w && hbX + range > opp.x && attacker.y < opp.y + opp.h && attacker.y + height > opp.y) {
            applyDamage(opp, attacker.id, dmg, kb, attacker.facing);
            io.emit('spawn_particles', {x: opp.x + opp.w/2, y: opp.y + opp.h/2, color: '#ffffff', count: 8});
        }
    });
}

function applyDamage(target, attackerId, dmg, baseKb, dir) {
    let force = baseKb + (target.damage + dmg) * 0.18;
    
    // Correction Killcam : Doit être fatale (Force élevée et > 110%) et dernière vie
    if (target.stocks === 1 && (target.damage + dmg) >= 110 && force >= 22) {
        killcam = { active: true, timer: 60, x: target.x + target.w/2, y: target.y + target.h/2 };
    }

    target.damage += dmg;
    target.lastHitter = attackerId;
    target.vx = dir * force;
    target.vy = -force * 0.45;
    target.hitstun = Math.round(12 + target.damage * 0.12);
    target.isCharging = false; target.actionState = 'IDLE';
}

function checkDeath(p) {
    if (p.x < -200 || p.x > 1800 || p.y > 800 || p.y < -300) {
        io.emit('spawn_particles', {x: p.x < 0 ? 30 : (p.x > 1600 ? 1570 : p.x), y: p.y < 0 ? 30 : (p.y > 600 ? 570 : p.y), color: p.color, count: 45});
        
        p.stocks--;
        p.x = mainStage.x + mainStage.w / 2;
        p.y = 100; p.vx = 0; p.vy = 0; p.damage = 0;
        let bonus = BONUSES[p.perk];
        p.jumps = bonus.maxJumps;

        if (p.lastHitter && players[p.lastHitter]) players[p.lastHitter].kills++;
        p.lastHitter = null;

        let alivePlayers = Object.values(players).filter(pl => pl.stocks > 0 && !pl.isSpectator);
        if (p.stocks === 0 && alivePlayers.length <= 1) {
            killcam = { active: true, timer: 90, x: 800, y: 300 };
        }
    }
}

function checkGameOver() {
    let alivePlayers = Object.values(players).filter(p => p.stocks > 0 && !p.isSpectator);
    if (gameState === 'PLAYING' && alivePlayers.length <= 1) {
        gameState = 'GAMEOVER';
        gameWinner = alivePlayers.length === 1 ? alivePlayers[0] : null;
        io.emit('game_over', gameWinner ? { name: gameWinner.name, kills: gameWinner.kills } : { name: 'Égalité', kills: 0 });
        setTimeout(() => {
            gameState = 'WAITING';
            Object.keys(players).forEach(id => {
                if(players[id].isBot) delete players[id];
                else { players[id].ready = false; players[id].stocks = 3; }
            });
            sendLobbyUpdate();
            io.emit('state_update', gameState);
        }, 6000);
    }
}

function runAI(bot, allPlayers) {
    let targets = allPlayers.filter(p => p.id !== bot.id && p.stocks > 0 && !p.isSpectator);
    if (targets.length === 0) return;
    
    let opp = targets.reduce((prev, curr) => (Math.abs(curr.x - bot.x) < Math.abs(prev.x - bot.x) ? curr : prev));
    const dist = opp.x + opp.w/2 - (bot.x + bot.w/2);
    const absDist = Math.abs(dist);
    const isG = onGround(bot);
    const stageCenter = mainStage.x + mainStage.w / 2;

    bot.inputs = { left: false, right: false, jump: false, attack: false, shoot: false, charge: false };

    if (!isG && (bot.x < mainStage.x - 10 || bot.x > mainStage.x + mainStage.w + 10)) {
        bot.inputs[stageCenter > bot.x ? 'right' : 'left'] = true;
        if (bot.jumps > 0 && bot.vy > 1) bot.inputs.jump = true;
        return;
    }

    if (isG) {
        if (bot.x < mainStage.x + 30 && bot.vx < 0) { bot.inputs.right = true; return; }
        if (bot.x > mainStage.x + mainStage.w - 30 && bot.vx > 0) { bot.inputs.left = true; return; }
    }

    bot.aiTimer--;
    if (bot.aiTimer <= 0) {
        const r = Math.random();
        if (absDist < 60) { bot.aiState = r < 0.4 ? 'ATTACK' : (r < 0.6 ? 'RETREAT' : 'CHARGE_ATTACK'); bot.aiTimer = 10; }
        else if (absDist < 200) { bot.aiState = r < 0.4 ? 'APPROACH' : (r < 0.7 ? 'SHOOT' : 'BAIT'); bot.aiTimer = 15; }
        else { bot.aiState = r < 0.7 ? 'SHOOT' : 'APPROACH'; bot.aiTimer = 20; }
    }

    switch (bot.aiState) {
        case 'APPROACH': bot.inputs[dist > 0 ? 'right' : 'left'] = true; break;
        case 'ATTACK': bot.inputs[dist > 0 ? 'right' : 'left'] = true; bot.inputs.attack = true; break;
        case 'SHOOT': bot.facing = dist > 0 ? 1 : -1; bot.inputs.shoot = true; break;
        case 'RETREAT': bot.inputs[dist > 0 ? 'left' : 'right'] = true; break;
        case 'CHARGE_ATTACK':
            if (!bot.isCharging) { bot.inputs.charge = true; bot.aiChargeTarget = 20 + Math.floor(Math.random() * 30); }
            else { bot.inputs.charge = true; if (bot.chargeFrames >= bot.aiChargeTarget) bot.inputs.charge = false; }
            break;
    }
}

const PORT = 8080;
server.listen(PORT, () => console.log(`Serveur "Tactical" lancé sur le port ${PORT}`));