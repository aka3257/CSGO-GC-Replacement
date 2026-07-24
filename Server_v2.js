const http = require('http');
const protobuf = require('protobufjs');
const fs = require('fs');

const root = protobuf.loadSync([
    "proto/gcsystemmsgs.proto",
    "proto/cstrike15_usermessages.proto",
    "proto/gcsdk_gcmessages.proto"
]);

const DEVMODE = 1  //switch to 1 for advanced logging

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

events.on('CMsgGCClientHello', (data, client) => {

    console.log('[HANDLER] ClientHello')

    client.session = {
        accountId: null,
        rankings: {
            wingman: {
                rank: 1,
                wins: 0
            },
            competitive: {
                rank: 1,
                wins: 0
            },
            dangerzone: {
                rank: 1,
                wins: 0
            }
        },
        matchmaking: false,
        matchId: null,
        partyId: null,
        lastPing: Date.now(),
        isInitiatedMMSearchStop: false
    };

        // Создаем CMsgCStrike15Welcome
    const csWelcome = {
        storeItemHash: 0,
        timeplayedconsecutively: 0,
        timeFirstPlayed: Math.floor(Date.now() / 1000),
        lastTimePlayed: Math.floor(Date.now() / 1000),
        lastIpAddress: 0,
        gscookieid: Math.floor(Math.random() * 1000000000),
        uniqueid: Math.floor(Math.random() * 1000000000)
    };

    const CsWelcomeType = root.lookupType('CMsgCStrike15Welcome');
    const gamedata = CsWelcomeType.encode(csWelcome).finish();

    // Отправляем ClientWelcome
    sendProto(client, 4004, 'CMsgGCClientWelcome', {
        version: 13881,
        gameData: gamedata,
        outofdate_subscribed_caches: [],
        uptodate_subscribed_caches: [],
        location: {
            latitude: 55.7558,
            longitude: 37.6173,
            country: "RU"
        },
        gameData2: Buffer.alloc(0),
        rtime32GcWelcomeTimestamp: Math.floor(Date.now() / 1000),
        currency: 0,
        balance: 0,
        balanceUrl: "",
        txnCountryCode: "RU"
    });
//    savePlayer(accountId)
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, client) => {
    const accountIds = data?.account_ids || [];
    const accountId = accountIds[0] || 13371337;
    const session = sessions.get(accountId)
    console.log(`[HANDLER] Matchmaking Start for ${accountId}`);
    const gameType = data?.game_type || 0;
    
    if (session) {
        session.matchmaking = true;
        savePlayer(accountId)
    }

    sendProto(client, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [13371337],
        globalStats: {
            playersOnline: 1000000,
            serversOnline: 50000,
            playersSearching: 5,
            serversAvailable: 30000,
            ongoingMatches: 5000,
            searchTimeAvg: 30,
            requiredAppidVersion: 13881,
            rtime32Cur: Math.floor(Date.now() / 1000)
        },
        notes: [
            {
                type: 462552584,
                regionId: 0,
                regionR: 0,
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

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, client) => {
    console.log('[HANDLER] Ping');
    sendProto(client, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [13371337],
        globalStats: {
            playersOnline: 1000000,
            serversOnline: 50000,
            playersSearching: 5,
            serversAvailable: 30000,
            ongoingMatches: 5000,
            searchTimeAvg: 30,
            requiredAppidVersion: 13881,
            rtime32Cur: Math.floor(Date.now() / 1000)
        },
        notes: [
            {
                type: 462552584,
                regionId: 0,
                regionR: 0,
                distance: 0
            }
        ]
    });
});

events.on('CMsgGCCStrike15_v2_GetEventFavorites_Request', (data, client) => {
    console.log('[HANDLER] GetEventFavorites');
    sendProto(client, 9203, 'CMsgGCCStrike15_v2_GetEventFavorites_Response', {
        allEvents: false,
        jsonFavorites: "{}",
        jsonFeatured: "{}"
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStop', (data, client) => {
    const accountId = data?.account_id || 13371337;
    const session = sessions.get(accountId);

    console.log(`[MATCHMAKING STOP] Received for ${accountId}`);

    if (sessions.isInitiatedMMSearchStop = false) {
        sendProto(client, 9102, 'CMsgGCCStrike15_v2_MatchmakingStop', {
            abandon: 1
        })
        sessions.isInitiatedMMSearchStop = true
    } else {
        sendProto(client, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
            matchmaking: 2,  // Stopped
            waitingAccountIdSessions: [],
            error: "",
            ongoingmatchAccountIdSessions: [],
            globalStats: {
                playersOnline: 1000000,
                serversOnline: 50000,
                playersSearching: 0,
                serversAvailable: 30000,
                ongoingMatches: 5000,
                searchTimeAvg: 30,
                requiredAppidVersion: 13881,
                rtime32Cur: Math.floor(Date.now() / 1000)
            },
            notes: []
        });
        sessions.isInitiatedMMSearchStop = false
        sessions.matchmaking = false
    }
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, client) => {
    
    const accountId = data?.account_id || 13371337; 
    let session = sessions.get(accountId)

    if (!session) {
       console.log(`[ERROR] Session not found for ${accountId}`) 
    }

    console.log(`got Client2GCHello for id ${accountId}`)
    sendProto(client, 9109, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        account_id: session,
        ranking: {
                accountId: session,
                rankId: 6,
                wins: 150,
                rankTypeId: 1,
                rankWindowStats: 0,
                rankIfWin: 12,
                rankIfLose: 10,
                rankIfTie: 11
            },
        commendation: {
            cmdFriendly: 1337,
            cmdTeaching: 1488,
            cmdLeader: 3257
        },
        playerLevel: 28,
        playerCurXp: 11111,
        
    })
})

events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, client) => {
    console.log('[RANK UPDATE] Received');
    
    if (DEVMODE === 1) {
        console.log('RECEIVED RANK UPDATE, DATA:', JSON.stringify(data, null, 2));
    }

    const accountId = data?.account_id || 13371337;
    const session = sessions.get(accountId);
    
    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        // Отправляем пустой ответ, чтобы клиент не спамил
        sendProto(client, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: []
        });
        return;
    }
    
    console.log(`[RANK UPDATE] for ${accountId}, competitive rank: ${session.rankings.competitive.rank}`);
    
    sendProto(client, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
        rankings: [
            {
                account_id: accountId,
                rank_id: session.rankings.competitive.rank || 1,
                wins: session.rankings.competitive.wins || 0,
                rankTypeId: 6,
                rank_window_stats: 0,
                rankIfWin: 12,
                rankIfLose: 10,
                rankIfTie: 11
            },
//            {
//                account_id: accountId,
//                rank_id: session.rankings.wingman.rank || 1,
//                wins: session.rankings.wingman.wins || 0,
//                rank_type_id: 7,
//                rank_window_stats: 0,
//                rank_if_win: 12,
//                rank_if_lose: 10,
//                rank_if_tie: 11
//            },
//            {
//                account_id: accountId,
//                rank_id: session.rankings.dangerzone.rank || 1,
//                wins: session.rankings.dangerzone.wins || 0,
//                rank_type_id: 10,
//                rank_window_stats: 0,
//                rank_if_win: 12,
//                rank_if_lose: 10,
//                rank_if_tie: 11
//            }
        ]
    });
});

events.on('CMsgGCCStrike15_v2_Party_Register', (data, client) => {
    console.log('[PARTY] Register');
    sendProto(client, 9190, 'CMsgGCCStrike15_v2_Party_Unregister', {});
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