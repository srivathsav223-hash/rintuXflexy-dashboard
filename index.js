const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require("fs");
const path = require("path");

// Patch for selfbot
try {
    const ClientUserSettingManager = require("./node_modules/discord.js-selfbot-v13/src/managers/ClientUserSettingManager.js");
    if (ClientUserSettingManager && ClientUserSettingManager.prototype) {
        ClientUserSettingManager.prototype._patch = function(data) { return this; };
    }
} catch (e) {}

const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { spawn } = require("child_process");
const youtubedl = require("youtube-dl-exec");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// ─── TOKENS FROM DASHBOARD ONLY ───
let dashboardTokens = [];
let isBotRunning = false;

console.log(`🎯 RINTU DASHBOARD - Ready for tokens from dashboard`);

// Bot state
const clients = [];
const connections = new Map();
const players = new Map();
const activeResources = new Map();
let currentFFmpegProcess = null;
let currentUrl = null;
let currentTitle = "Nothing playing";
let currentChannelId = null;
let loopMode = false;
let isPaused = false;
let isBassboosted = false;
let currentVolumeMultiplier = 1.0;
let blastMode = false;
let blastVolume = 50.0;
let pungiMode = false;
let pungiIntensity = 50.0;
let loudMode = false;
let loudModeBoost = 20.0;
let loudModeMaxVolume = 500.0;
let loudModeInterval = null;
let superLoudMode = false;
let forceLoudMode = false;

function stopFFmpeg() {
    if (currentFFmpegProcess) {
        try { currentFFmpegProcess.kill("SIGKILL"); } catch (e) {}
        currentFFmpegProcess = null;
    }
}

function stopLoudMode() {
    if (loudModeInterval) {
        clearInterval(loudModeInterval);
        loudModeInterval = null;
    }
    loudMode = false;
}

function startLoudMode() {
    if (loudModeInterval) clearInterval(loudModeInterval);
    loudModeInterval = setInterval(() => {
        if (!loudMode || connections.size === 0) return;
        const primaryClient = clients[0];
        if (!primaryClient || !currentChannelId) return;
        const channel = primaryClient.channels.cache.get(currentChannelId);
        if (!channel) return;
        const clusterIds = clients.map(c => c.user?.id).filter(Boolean);
        const speakingMembers = channel.members.filter(m => {
            return !clusterIds.includes(m.id) && !m.voice.selfMute && m.voice.speaking;
        });
        const targetVolume = speakingMembers.size > 0 
            ? Math.min(currentVolumeMultiplier * loudModeBoost, loudModeMaxVolume)
            : currentVolumeMultiplier;
        activeResources.forEach((resource) => {
            if (resource && resource.volume && resource.volume.volume !== targetVolume) {
                resource.volume.setVolume(targetVolume);
            }
        });
    }, 400);
}

function isYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
}

function startFFmpegStream(inputSource) {
    stopFFmpeg();
    let audioFilters = [];
    audioFilters.push("highpass=f=60");

    if (superLoudMode) {
        audioFilters.push("compand=attacks=0.01:decays=0.01:points=-80/-80|-30/-15|-12/-6|-6/-3|0/-2|20/-1");
        audioFilters.push("volume=15dB");
        audioFilters.push("acompressor=threshold=0.05:ratio=20:attack=5:release=50");
        audioFilters.push("alimiter=level_in=15:level_out=0:limit=0.99:attack=1:release=50");
        audioFilters.push("dynaudnorm=p=0.95:m=100:g=20");
        audioFilters.push("volume=amplitude=8");
    }
    if (forceLoudMode) {
        audioFilters.push("compand=attacks=0.001:decays=0.001:points=-80/-80|-40/-25|-20/-10|0/-5|10/-2|20/0|30/5");
        audioFilters.push("acompressor=threshold=0.01:ratio=50:attack=1:release=100");
        audioFilters.push("alimiter=level_in=25:level_out=0.99:limit=1:attack=1:release=100");
        audioFilters.push("dynaudnorm=p=1:m=100:g=30");
        audioFilters.push("volume=20dB");
        audioFilters.push("aecho=0.8:0.9:1000:0.3");
    }
    if (isBassboosted) {
        audioFilters.push("equalizer=f=60:width_type=h:width=50:g=15");
    }
    if (pungiMode) {
        audioFilters.push("acrusher=bits=4:mode=log:aa=1");
        audioFilters.push("equalizer=f=30:width_type=h:width=80:g=20");
        audioFilters.push("equalizer=f=1000:width_type=h:width=500:g=10");
        audioFilters.push(`volume=${pungiIntensity}`);
        audioFilters.push("aphaser=0.8:0.8:2000:0.4");
        audioFilters.push("aecho=0.8:0.9:1000:0.3");
    } else if (blastMode) {
        audioFilters.push(`volume=${blastVolume}`);
        audioFilters.push("dynaudnorm=p=0.9:m=50.0:g=15");
        audioFilters.push("alimiter=level_in=2.0:level_out=0.98:limit=0.99:attack=5:release=50");
    } else {
        if (currentVolumeMultiplier > 1.0) {
            audioFilters.push(`volume=${currentVolumeMultiplier}`);
        }
    }

    currentFFmpegProcess = spawn("ffmpeg", [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", inputSource,
        "-filter:a", audioFilters.join(","),
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
    ]);

    clients.forEach((client, index) => {
        const player = players.get(index);
        if (player && currentFFmpegProcess) {
            const resource = createAudioResource(currentFFmpegProcess.stdout, {
                inputType: StreamType.Raw,
                inlineVolume: true
            });
            let effectiveVol = currentVolumeMultiplier;
            if (pungiMode) effectiveVol = Math.min(pungiIntensity, 200.0);
            else if (blastMode) effectiveVol = Math.min(blastVolume, 500.0);
            else if (superLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 20, 2000.0);
            else if (forceLoudMode) effectiveVol = Math.min(currentVolumeMultiplier * 30, 3000.0);
            else effectiveVol = Math.min(currentVolumeMultiplier * 2, 200.0);
            resource.volume.setVolume(effectiveVol);
            activeResources.set(index, resource);
            player.play(resource);
            io.emit('audio_update', { 
                status: 'playing', 
                title: currentTitle, 
                volume: Math.round(effectiveVol * 100) 
            });
        }
    });
    isPaused = false;
    if (loudMode) startLoudMode();
}

function startBots() {
    if (isBotRunning) return;
    
    if (dashboardTokens.length === 0) {
        console.log("❌ No tokens available! Add tokens in dashboard.");
        return;
    }
    
    isBotRunning = true;
    dashboardTokens.forEach((token, index) => {
        const client = new Client({ checkUpdate: false });
        client.on("ready", () => {
            console.log(`🤖 Bot ${index + 1}/${dashboardTokens.length}: ${client.user.tag}`);
            io.emit('bot_status', { index: index + 1, total: dashboardTokens.length, tag: client.user.tag, status: 'online' });
        });
        client.login(token).catch((err) => {
            console.log(`❌ Bot ${index + 1} login failed: ${err.message}`);
        });
        clients.push(client);
    });
    io.emit('bots_started', { count: dashboardTokens.length });
}

function stopBots() {
    isBotRunning = false;
    stopFFmpeg();
    stopLoudMode();
    players.forEach(p => p.stop());
    players.clear();
    connections.forEach(c => { try { c.destroy(); } catch(e){} });
    connections.clear();
    activeResources.clear();
    clients.forEach(c => { try { c.destroy(); } catch(e){} });
    clients.length = 0;
    currentUrl = null;
    currentChannelId = null;
    io.emit('bots_stopped');
    console.log("⛔ All bots stopped");
}

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        isRunning: isBotRunning,
        botCount: clients.length,
        totalTokens: dashboardTokens.length,
        currentTitle: currentTitle,
        volume: Math.round(currentVolumeMultiplier * 100),
        isPaused, loopMode, isBassboosted, blastMode, pungiMode, loudMode, superLoudMode, forceLoudMode,
        connected: connections.size > 0
    });
});

app.post('/api/command', async (req, res) => {
    const { command } = req.body;
    if (!command) return res.json({ error: 'No command' });
    
    const lowerCmd = command.toLowerCase().trim();
    let response = '';

    try {
        if (lowerCmd === 'help') {
            response = `Commands: play <url>, volume <1-20000>, max, blast, doubleblast, superloud, forceloud, bassboost, pungi, pungiset, loudmode, loop, pause, resume, stop, leave, status\n📊 ${dashboardTokens.length} tokens loaded`;
        }
        else if (lowerCmd.startsWith('play ')) {
            const url = command.slice(5).trim();
            if (connections.size === 0) {
                response = '❌ Join a voice channel first!';
            } else if (isYouTubeUrl(url)) {
                try {
                    const result = await youtubedl(url, {
                        dumpSingleJson: true,
                        noPlaylist: true,
                        format: "bestaudio[ext=webm]/bestaudio/best",
                        noWarnings: true
                    });
                    currentUrl = result.url;
                    currentTitle = result.title || "YouTube Audio";
                    startFFmpegStream(currentUrl);
                    response = `▶️ Now Playing: ${currentTitle}`;
                } catch (err) {
                    response = `❌ Error: ${err.message}`;
                }
            } else {
                currentUrl = url;
                currentTitle = "Direct Audio";
                startFFmpegStream(url);
                response = `▶️ Playing: ${url}`;
            }
        }
        else if (lowerCmd === 'stop') {
            stopFFmpeg();
            stopLoudMode();
            players.forEach(p => p.stop());
            activeResources.clear();
            response = '⏹️ Playback stopped';
        }
        else if (lowerCmd === 'pause') {
            players.forEach(p => p.pause());
            isPaused = true;
            response = '⏸️ Paused';
        }
        else if (lowerCmd === 'resume') {
            players.forEach(p => p.unpause());
            isPaused = false;
            response = '▶️ Resumed';
        }
        else if (lowerCmd === 'leave') {
            stopFFmpeg();
            stopLoudMode();
            players.forEach(p => p.stop());
            players.clear();
            connections.forEach(c => { try { c.destroy(); } catch(e){} });
            connections.clear();
            activeResources.clear();
            currentUrl = null;
            currentChannelId = null;
            response = '👋 Disconnected all bots';
        }
        else if (lowerCmd.startsWith('volume ')) {
            const vol = parseInt(command.slice(7).trim(), 10);
            if (isNaN(vol) || vol < 1 || vol > 20000) {
                response = '❌ Volume must be 1-20000';
            } else {
                currentVolumeMultiplier = vol / 100;
                activeResources.forEach((res) => {
                    if (res?.volume) res.volume.setVolume(currentVolumeMultiplier);
                });
                response = `🔊 Volume set to ${vol}%`;
            }
        }
        else if (lowerCmd === 'max') {
            currentVolumeMultiplier = 100.0;
            activeResources.forEach((res) => {
                if (res?.volume) res.volume.setVolume(currentVolumeMultiplier);
            });
            if (currentUrl) startFFmpegStream(currentUrl);
            response = '💥 MAXIMUM VOLUME (10000%)';
        }
        else if (lowerCmd === 'blast') {
            blastMode = !blastMode;
            pungiMode = false; superLoudMode = false; forceLoudMode = false;
            if (currentUrl) startFFmpegStream(currentUrl);
            response = `🔥 Blast Mode ${blastMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
        }
        else if (lowerCmd === 'doubleblast') {
            blastMode = true; pungiMode = false; superLoudMode = false; forceLoudMode = false;
            blastVolume = 100.0; currentVolumeMultiplier = 100.0;
            activeResources.forEach((res) => {
                if (res?.volume) res.volume.setVolume(100.0);
            });
            if (currentUrl) startFFmpegStream(currentUrl);
            response = '💥💥 DOUBLE BLAST ACTIVATED!';
        }
        else if (lowerCmd === 'superloud') {
            superLoudMode = !superLoudMode;
            if (superLoudMode) { blastMode = false; pungiMode = false; forceLoudMode = false; }
            if (currentUrl) startFFmpegStream(currentUrl);
            response = `🔊 Super Loud ${superLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
        }
        else if (lowerCmd === 'forceloud') {
            forceLoudMode = !forceLoudMode;
            if (forceLoudMode) { blastMode = false; pungiMode = false; superLoudMode = false; }
            if (currentUrl) startFFmpegStream(currentUrl);
            response = `🔥 Force Loud ${forceLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
        }
        else if (lowerCmd === 'bassboost') {
            isBassboosted = !isBassboosted;
            if (currentUrl) startFFmpegStream(currentUrl);
            response = `🎵 Bassboost ${isBassboosted ? 'ENABLED' : 'DISABLED'}`;
        }
        else if (lowerCmd === 'pungi') {
            pungiMode = !pungiMode;
            blastMode = false; superLoudMode = false; forceLoudMode = false;
            if (currentUrl) startFFmpegStream(currentUrl);
            response = `🐍 Pungi Mode ${pungiMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
        }
        else if (lowerCmd.startsWith('pungiset ')) {
            const val = parseFloat(command.slice(9).trim());
            if (isNaN(val) || val < 1 || val > 200) {
                response = '❌ Intensity must be 1-200';
            } else {
                pungiIntensity = val;
                if (pungiMode && currentUrl) startFFmpegStream(currentUrl);
                response = `🐍 Pungi intensity set to ${val}x`;
            }
        }
        else if (lowerCmd === 'loudmode') {
            loudMode = !loudMode;
            if (loudMode) startLoudMode();
            else stopLoudMode();
            response = `🔊 Loud Mode ${loudMode ? 'ENABLED' : 'DISABLED'}`;
        }
        else if (lowerCmd === 'loop') {
            loopMode = !loopMode;
            response = `🔄 Loop ${loopMode ? 'ENABLED' : 'DISABLED'}`;
        }
        else if (lowerCmd === 'status') {
            response = `🎵 ${currentTitle}\n📊 ${clients.length}/${dashboardTokens.length} bots online\n🔊 ${Math.round(currentVolumeMultiplier * 100)}%\n🔄 Loop: ${loopMode ? 'ON' : 'OFF'}`;
        }
        else if (!isNaN(lowerCmd) && lowerCmd.length >= 10) {
            currentChannelId = lowerCmd;
            for (const [index, client] of clients.entries()) {
                try {
                    const channel = await client.channels.fetch(lowerCmd);
                    if (channel) {
                        const conn = joinVoiceChannel({
                            channelId: channel.id,
                            guildId: channel.guild.id,
                            adapterCreator: channel.guild.voiceAdapterCreator,
                            selfMute: false,
                            selfDeaf: false,
                            group: client.user.id
                        });
                        const player = createAudioPlayer();
                        conn.subscribe(player);
                        player.on(AudioPlayerStatus.Idle, () => {
                            if (loopMode && currentUrl && !isPaused && index === 0) {
                                setTimeout(() => startFFmpegStream(currentUrl), 500);
                            }
                        });
                        connections.set(index, conn);
                        players.set(index, player);
                    }
                } catch (err) {
                    console.log(`❌ Bot ${index + 1} join error: ${err.message}`);
                }
            }
            response = `✅ Connected ${clients.length} bots to channel ${lowerCmd}`;
        }
        else {
            response = '❌ Unknown command. Type "help" for list.';
        }
    } catch (err) {
        response = `❌ Error: ${err.message}`;
    }

    io.emit('command_response', { command, response });
    res.json({ response });
});

// ─── SOCKET.IO ───
io.on('connection', (socket) => {
    console.log('📱 Dashboard connected');
    socket.emit('status_update', {
        isRunning: isBotRunning,
        botCount: clients.length,
        totalTokens: dashboardTokens.length,
        currentTitle: currentTitle,
        volume: Math.round(currentVolumeMultiplier * 100)
    });
    
    // Handle tokens from dashboard
    socket.on('start_bot_with_tokens', (data) => {
        const { tokens: newTokens } = data;
        if (newTokens && newTokens.length > 0) {
            dashboardTokens = [];
            for (const t of newTokens) {
                if (t && t.length > 10) {
                    dashboardTokens.push(t);
                }
            }
            console.log(`🔄 Updated tokens from dashboard: ${dashboardTokens.length} tokens`);
            startBots();
        } else {
            console.log('❌ No valid tokens received from dashboard');
        }
    });
    
    socket.on('start_bots', () => startBots());
    socket.on('stop_bots', () => stopBots());
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🌐 RINTU DASHBOARD: http://localhost:${PORT}`);
    console.log(`📱 Add tokens in dashboard and press START!\n`);
});
