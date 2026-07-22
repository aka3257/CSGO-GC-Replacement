const http = require('http');
const protobuf = require('protobufjs');
const fs = require('fs');

const root = protobuf.loadSync([
    "proto/gcsystemmsgs.proto",
    "proto/cstrike15_usermessages.proto",
    "proto/gcsdk_gcmessages.proto"
]);

const DEVMODE = 0  //switch to 1 for advanced logging

const DATA_DIR = './playerData';

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// ID dictionary

const IDict = {
    4004: 'CMsgGCClientWelcome',
    4005: 'CMsgGCServerWelcome',
    4006: 'CMsgGCClientHello',
    4007: 'CMsgGCServerHello',
    9101: 'CMsgGCCStrike15_v2_MatchmakingStart',
    9102: 'CMsgGCCStrike15_v2_MatchmakingStop',
    9103: 'CMsgGCCStrike15_v2_MatchmakingClient2ServerPing',
    9104: 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate',
    9106: 'CMsgGCCStrike15_v2_MatchmakingServerReservationResponse',
    9107: 'CMsgGCCStrike15_v2_MatchmakingGC2ClientReserve',
    9109: 'CMsgGCCStrike15_v2_MatchmakingClient2GCHello',
    9110: 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello',
    9112: 'CMsgGCCStrike15_v2_MatchmakingGC2ClientAbandon',
    9189: 'CMsgGCCStrike15_v2_Party_Register',
    9190: 'CMsgGCCStrike15_v2_Party_Unregister',
    9194: 'CMsgGCCStrike15_v2_ClientGCRankUpdate',
    9201: 'CMsgGCCStrike15_v2_GetEventFavorites_Request',
    9203: 'CMsgGCCStrike15_v2_GetEventFavorites_Response',
};

function getMessageNameById(id) {
    return IDict[id] || null;
}

const ReverseIDict = {};
for (const id in IDict) {
    ReverseIDict[IDict[id]] = Number(id);
}

// functions

function encodeGCMessage(messageName, object) {
    const msgId = ReverseIDict[messageName];
    if (!msgId) {
        console.log(`[ERROR] Unknown message: ${messageName}`);
        return null;
    }
    try {
        const MessageType = root.lookupType(messageName);
        const message = MessageType.fromObject(object);
        const payload = MessageType.encode(message).finish();
        const finalMsgType = (0x80000000 | msgId) >>> 0;
        return JSON.stringify({
            msgType: finalMsgType,
            data: payload.toString('hex')
        });
    } catch (err) {
        console.error(`[ERROR] encodeGCMessage:`, err.message);
        return null;
    }
}

function sendProto(res, msgType, protoName, object) {
    try {
        if (DEVMODE === 1) {
            console.log('Sent object:', JSON.stringify(object, null, 2));
        }
        const Proto = root.lookupType(protoName);
        const message = Proto.fromObject(object);
        const payload = Proto.encode(message).finish();
        
        const finalMsgType = (0x80000000 | msgType) >>> 0;
        const response = JSON.stringify({
            msgType: finalMsgType,
            data: payload.toString('hex')
        });
        
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(response)
        });
        res.end(response);
        console.log(`[SENT] ${protoName} (${finalMsgType})`);
        return true;
    } catch (err) {
        console.error(`[ERROR] sendProto:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
        return false;
    }
}

function getMSGdata(data) {
    try {
        const parsed = JSON.parse(data.toString());
        const msgId = parsed.msgType & 0x7FFFFFFF;
        const messageName = getMessageNameById(msgId);
        const isResponse = (parsed.msgType & 0x80000000) !== 0;
        if (DEVMODE === 1) {
            console.log(`[RAW] MsgType: ${msgId}, Name: ${messageName || 'UNKNOWN'}`);
        }
        if (!messageName) {
            console.log('Unknown message');
            return null;
        }
        
        const payload = Buffer.from(parsed.data, 'hex');
        const protoData = payload.subarray(8);
        const MessageType = root.lookupType(messageName);
        const decoded = MessageType.decode(protoData);
        if (DEVMODE === 1) {
            console.log('DATA:', JSON.stringify(decoded, null, 2));
        }
        return { name: messageName, data: decoded };
    } catch (err) {
        console.error(`[ERROR] getMSGdata:`, err.message);
        return null;
    }
}

// save player data
function savePlayer(accountId) {
    const accId = sessions.get(accountId);
    if (!accId) return;
    const filePath = `${DATA_DIR}/${accountId}.json`;
    fs.writeFileSync(filePath, JSON.stringify(accId, null, 2));
}

// load player data
function loadPlayer(accountId) {
    const filePath = `${DATA_DIR}/${accountId}.json`;
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}

// event system

class EventBus {
    constructor() {
        this.handlers = new Map();
    }

    on(eventName, handler) {
        if (!this.handlers.has(eventName)) {
            this.handlers.set(eventName, []);
        }
        this.handlers.get(eventName).push(handler);
        console.log(`[EVENT] Subscribed: ${eventName}`);
    }

    emit(eventName, data, res) {
        if (this.handlers.has(eventName)) {
            for (const handler of this.handlers.get(eventName)) {
                handler(data, res);
            }
            return true;
        }
        return false;
    }
}

const events = new EventBus();

// events

const sessions = new Map();

events.on('CMsgGCClientHello', (data, res) => {
    const accountId = data?.account_id || 100000000;
    console.log(`[HANDLER] ClientHello for ${accountId}`)
    let session = loadPlayer(accountId)

    if (!session) {
        session = {
            accountId: accountId,
            rankings: {
                wingman: {
                    rank: 5,
                    wins: 69
                },
                competitive: {
                    rank: 1,
                    wins: 5
                },
                dangerzone: {
                    rank: 1,
                    wins: 1
                }
            },
            matchmaking: false,
            matchId: null,
            partyId: null,
            lastPing: Date.now(),
            isInitiatedMMSearchStop: false
        };
        sessions.set(accountId, session);
    } else {
        sessions.set(accountId, session);
    }

    sendProto(res, 4004, 'CMsgGCClientWelcome', {
        version: 1575,
        legacy_version: data?.legacy_version || 0,
        clientLauncher: data?.clientLauncher || 0
    });
    savePlayer(accountId)
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, res) => {
    const accountIds = data?.account_ids || [];
    const accountId = accountIds[0] || 100000000;
    const session = sessions.get(accountId)
    console.log(`[HANDLER] Matchmaking Start for ${accountId}`);
    const gameType = data?.game_type || 0;
    
    if (session) {
        session.matchmaking = true;
        savePlayer(accountId)
    }

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waiting_account_id_sessions: [accountId],
        error: "",
        ongoingmatch_account_id_sessions: [],
        global_stats: {
            players_online: 1000000,
            servers_online: 50000,
            players_searching: 5,  //accountIds.length,
            servers_available: 30000,
            ongoing_matches: 5000,
            search_time_avg: 30,
            search_statistics: [],
            required_appid_version: 1575,
            rtime32_cur: Math.floor(Date.now() / 1000)
        },
        failping_account_id_sessions: [],
        penalty_account_id_sessions: [],
        failready_account_id_sessions: [],
        vacbanned_account_id_sessions: [],
        notes: [
            {
                type: gameType,
                region_id: 0,
                region_r: 0,
                distance: 0
            }
        ],
        penalty_account_id_sessions_green: [],
        insufficientlevel_sessions: [],
        vsncheck_account_id_sessions: [],
        launcher_mismatch_sessions: [],
        insecure_account_id_sessions: []
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, res) => {
    console.log('[HANDLER] Ping');
    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waiting_account_id_sessions: [985123137],
        global_stats: {
            players_online: 1000000,
            servers_online: 50000,
            players_searching: 5,
            servers_available: 30000,
            ongoing_matches: 5000,
            search_time_avg: 30,
            required_appid_version: 13881,
            rtime32_cur: Math.floor(Date.now() / 1000)
        },
        notes: [
            {
                type: 462552584,
                region_id: 0,
                region_r: 0,
                distance: 0
            }
        ]
    });
});

events.on('CMsgGCCStrike15_v2_GetEventFavorites_Request', (data, res) => {
    console.log('[HANDLER] GetEventFavorites');
    sendProto(res, 9203, 'CMsgGCCStrike15_v2_GetEventFavorites_Response', {
        all_events: false,
        json_favorites: "{}",
        json_featured: "{}"
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStop', (data, res) => {
    const accountId = data?.account_id || 100000000;
    const session = sessions.get(accountId);

    console.log(`[MATCHMAKING STOP] Received for ${accountId}`);

    if (sessions.isInitiatedMMSearchStop = false) {
        sendProto(res, 9102, 'CMsgGCCStrike15_v2_MatchmakingStop', {
            abandon: 1
        })
        sessions.isInitiatedMMSearchStop = true
    } else {
        sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
            matchmaking: 2,  // Stopped
            waiting_account_id_sessions: [],
            error: "",
            ongoingmatch_account_id_sessions: [],
            global_stats: {
                players_online: 1000000,
                servers_online: 50000,
                players_searching: 0,
                servers_available: 30000,
                ongoing_matches: 5000,
                search_time_avg: 30,
                required_appid_version: 1575,
                rtime32_cur: Math.floor(Date.now() / 1000)
            },
            notes: []
        });
        sessions.isInitiatedMMSearchStop = false
        sessions.matchmaking = false
    }
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, res) => {
    
    const accountId = data?.account_id || 100000000; 
    let session = sessions.get(accountId)

    if (!session) {
       console.log(`[ERROR] Session not found for ${accountId}`) 
    }

    console.log(`got Client2GCHello for id ${accountId}`)
    sendProto(res, 9109, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        account_id: session,
        ranking: {
                account_id: session,
                rank_id: 6,
                wins: 150,
                rank_type_id: 1,
                rank_window_stats: 0,
                rank_if_win: 12,
                rank_if_lose: 10,
                rank_if_tie: 11
            },
        commendation: {
            cmd_friendly: 1337,
            cmd_teaching: 1488,
            cmd_leader: 3257
        },
        player_level: 28,
        player_cur_xp: 11111,
        
    })
})

events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, res) => {
    console.log('[RANK UPDATE] Received');
    
    const accountId = data?.account_id || 100000000;
    const session = sessions.get(accountId);
    
    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        // Отправляем пустой ответ, чтобы клиент не спамил
        sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: []
        });
        return;
    }
    
    console.log(`[RANK UPDATE] for ${accountId}, competitive rank: ${session.rankings.competitive.rank}`);
    
    sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
        rankings: [
            {
                account_id: accountId,
                rank_id: session.rankings.competitive.rank || 1,
                wins: session.rankings.competitive.wins || 0,
                rank_type_id: 1,
                rank_window_stats: 0,
                rank_if_win: 12,
                rank_if_lose: 10,
                rank_if_tie: 11
            },
            {
                account_id: accountId,
                rank_id: session.rankings.wingman.rank || 1,
                wins: session.rankings.wingman.wins || 0,
                rank_type_id: 2,
                rank_window_stats: 0,
                rank_if_win: 12,
                rank_if_lose: 10,
                rank_if_tie: 11
            },
            {
                account_id: accountId,
                rank_id: session.rankings.dangerzone.rank || 1,
                wins: session.rankings.dangerzone.wins || 0,
                rank_type_id: 3,
                rank_window_stats: 0,
                rank_if_win: 12,
                rank_if_lose: 10,
                rank_if_tie: 11
            }
        ]
    });
});

events.on('CMsgGCCStrike15_v2_Party_Register', (data, res) => {
    console.log('[PARTY] Register');
    sendProto(res, 9190, 'CMsgGCCStrike15_v2_Party_Unregister', {});
});

// server body

const server = http.createServer((req, res) => {
    console.log('Client connected');
    if (req.method === "POST" && req.url === '/gc') {
        let body = [];
        req.on('data', (chunk) => body.push(chunk));
        req.on('end', () => {
            try {
                const buffer = Buffer.concat(body);
                const decoded = getMSGdata(buffer);
                if (decoded) {
                    events.emit(decoded.name, decoded.data, res);
                } else {
                    const parsed = JSON.parse(buffer.toString());
                    const msgId = parsed.msgType & 0x7FFFFFFF;
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(JSON.stringify({ status: 'ok' }))
                    });
                    res.end(JSON.stringify({ status: 'ok' }));
                }
            } catch (err) {
                console.error('[ERROR]', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// params

const PORT = 3257;
const HOST = '192.168.1.40';

server.listen(PORT, HOST, () => {
    console.log(`Server running on ${HOST}:${PORT}`);
});