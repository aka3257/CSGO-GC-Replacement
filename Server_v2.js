const http = require('http');
const protobuf = require('protobufjs');

const root = protobuf.loadSync([
    "proto/gcsystemmsgs.proto",
    "proto/cstrike15_usermessages.proto",
    "proto/gcsdk_gcmessages.proto"
]);

const DEVMODE = 0  //switch to 1 for advanced logging

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
        console.log('Received object:', JSON.stringify(object, null, 2));
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
        console.log(`[RAW] MsgType: ${msgId}, Name: ${messageName || 'UNKNOWN'}, is resp from prev msg? ${isResponse}`);
        
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
    console.log('[HANDLER] ClientHello');

    const accountId = data?.account_id || 985123137;
    
    // create or get session
    if (!sessions.has(accountId)) {
        sessions.set(accountId, {
            accountId: accountId,
            rank: 10,
            wins: 150,
            inventory: [],
            matchmaking: false
        });
    }
    
    const session = sessions.get(accountId);

    if (data?.isResponse) {
        const csWelcome = {
            store_item_hash: 0,
            timeplayedconsecutively: 0,
            time_first_played: Math.floor(Date.now() / 1000),
            last_time_played: Math.floor(Date.now() / 1000),
            last_ip_address: 0,
            gscookieid: Math.floor(Math.random() * 1000000000),
            uniqueid: Math.floor(Math.random() * 1000000000)
        };
        
        const CsWelcomeType = root.lookupType('CMsgCStrike15Welcome');
        const gameData = CsWelcomeType.encode(csWelcome).finish();
        
        sendProto(res, 4004, 'CMsgGCClientWelcome', {
            version: 1575,
            game_data: gameData,
            outofdate_subscribed_caches: [],
            uptodate_subscribed_caches: [],
            location: {
                latitude: 55.7558,
                longitude: 37.6173,
                country: "RU"
            },
            game_data2: Buffer.from(''),
            rtime32_gc_welcome_timestamp: Math.floor(Date.now() / 1000),
            currency: 0,
            balance: 0,
            balance_url: "",
            txn_country_code: "RU"
        });
    } else {
        sendProto(res, 4007, 'CMsgGCServerHello', {
            version: 1575,
            legacy_version: data?.clientSessionNeed || 0,
            client_launcher: data?.clientLauncher || 0
        });
    }
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, res) => {
    console.log('[HANDLER] Matchmaking Start');
    const accountId = data?.account_ids || [985123137];
    const session = sessions.get(accountId)
    const gameType = data?.game_type || 0; // || data?.gameType
    
    if (session) {
        session.matchmaking = true;
    }

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waiting_account_id_sessions: accountId,
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
    console.log('[MATCHMAKING STOP] Received');
    const accountId = data?.account_id || 985123137;
    const session = sessions.get(accountId);
    if (session) {
        session.matchmaking = false;
    }
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
});

events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, res) => {
    sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
        rankings: [
            {
                account_id: 985123137,
                rank_id: 6,
                wins: 150,
                rank_type_id: 1,
                rank_window_stats: 0,
                highest_rank: 12,
                rank_expiry: Math.floor(Date.now() / 1000) + 86400 * 30
            }
        ]
    });
})

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