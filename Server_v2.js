const http = require('http');
const protobuf = require('protobufjs');
const fs = require('fs');

const CONFIG_FILE = './config.json'

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    console.log('[Notification] loaded config file!')
} catch (err) {
    console.log('[Notification] config file not found! if its first start its okay')
    const default_config = {
        host: '127.0.0.1',
        port: 3257,
        PlayerData: './playerData',
        protoPath: './proto',
        devmode: false
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(default_config, null, 2));
    config = default_config;
    console.log('[Notification] created config file')
    console.log('[Advice] specify your ip in config file')
}

const root = protobuf.loadSync([
    `${config.protoPath}/gcsystemmsgs.proto`,
    `${config.protoPath}/cstrike15_usermessages.proto`,
    `${config.protoPath}/gcsdk_gcmessages.proto`
]);

const DEVMODE = config.devmode;
const DATA_DIR = config.PlayerData;

if (DEVMODE === true) {
    console.log('[Notification] Server started in debug mode')
}

// id dictionary

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
        if (DEVMODE === true) {
            console.log('[DEBUG] Sent object:', JSON.stringify(object, null, 2));
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
        const steamId = parsed.steamid || 0;
        if (DEVMODE === true) {
            console.log(`[DEBUG] MsgType: ${msgId}, Name: ${messageName || 'UNKNOWN'}, steamid: ${steamId}`);
        }
        if (!messageName) {
            console.log('[ERROR] Unknown message');
            return null;
        }
        
        const payload = Buffer.from(parsed.data, 'hex');
        const protoData = payload.subarray(8);
        const MessageType = root.lookupType(messageName);
        const decoded = MessageType.decode(protoData);
        if (DEVMODE === true) {
            console.log('DATA:', JSON.stringify(decoded, null, 2));
        }
        return { name: messageName, steamid: steamId, data: decoded };
    } catch (err) {
        console.error(`[ERROR] getMSGdata:`, err.message);
        return null;
    }
}

function savePlayer(accountId) {
    const session = sessions.get(accountId);
    if (!session) return;
    const filePath = `${DATA_DIR}/${accountId}.json`;
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

function loadPlayer(accountId) {
    const filePath = `${DATA_DIR}/${accountId}.json`;
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}

function getOrCreateSession(steamId) {

//    const accountId = Number(steamId & 0xFFFFFFFFn); // if steam id is bigint
    const accountId = steamId % 2**32;

    let session = loadPlayer(accountId);
    if (!session) {
        session = {
            accountId: accountId,
            rankings: {
                competitive: {
                    rank: 1,
                    wins: 0
                },
                wingman: {
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
        savePlayer(accountId, session);
    }
    sessions.set(accountId, session)
    return { accountId, session };
}

// event handler

class EventBus {
    constructor() {
        this.handlers = new Map();
    }

    on(eventName, handler) {
        if (!this.handlers.has(eventName)) {
            this.handlers.set(eventName, []);
        }
        this.handlers.get(eventName).push(handler);
//        console.log(`[EVENT] Subscribed: ${eventName}`);
    }

    emit(eventName, data, res, steamid) {
        if (this.handlers.has(eventName)) {
            for (const handler of this.handlers.get(eventName)) {
                handler(data, res, steamid);
            }
            return true;
        }
        return false;
    }
}

const events = new EventBus();

// events(reqs from client)

const sessions = new Map();

events.on('CMsgGCClientHello', (data, res, steamid) => {
    console.log('[HANDLER] ClientHello');

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log('[ERROR] No steamid received');
        return;
    }

//    const accountId = Number(BigInt(steamid) & 0xFFFFFFFFn);
    const accId = getOrCreateSession(steamid)
    console.log(`[HANDLER] accountId: ${AccountId}`);

    let session = loadPlayer(AccountId);
    if (!session) {
        session = {
            accountId: AccountId,
            rankings: {
                competitive: {
                    rank: 1,
                    wins: 0
                },
                wingman: {
                    rank: 1,
                    wins: 0
                },
                dangerzone: {
                    rank: 1,
                    wins: 0
                }
            },
            playerLevel: 0,
            playerCurXp: 0,
            matchmaking: false,
            matchId: null,
            partyId: null,
            lastPing: Date.now(),
            isInitiatedMMSearchStop: false
        };
        sessions.set(AccountId, session)
        savePlayer(AccountId);

    }

//    sessions.set(accountId, session);

    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    const playerlevel = session.playerLevel || 1;
    const playercurxp = session.playerCurXp || 1;

    const csWelcome1 = {
//        storeItemHash: 0,
//        timeplayedconsecutively: 0,
//        timeFirstPlayed: Math.floor(Date.now() / 1000),
//        lastTimePlayed: Math.floor(Date.now() / 1000),
//        lastIpAddress: 0,
//        gscookieid: Math.floor(Math.random() * 1000000000),
//        uniqueid: Math.floor(Math.random() * 1000000000)
        status: 0
    };

    const csWelcome2 = {

        accountId: AccountId,
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
        vac_banned: 0,
        ranking: {
            accountId: AccountId,
            rankId: competitiverank,
            wins: session.rankings.competitive.wins || 0,
            rankTypeId: 6,
            rankWindowStats: 0,
            rankIfWin: Math.min(competitiverank + 1, 18), // не может быть выше 18
            rankIfLose: Math.max(competitiverank - 1, 1), // не может быть ниже 1
            rankIfTie: competitiverank
        }, 
        commendation: {
            cmdFriendly: 1337,
            cmdTeaching: 1488,
            cmdLeader: 3257
        },
        playerLevel: playerlevel,
        playerCurXp: playercurxp,
        rankings: [
            {
                accountId: AccountId,
                rankId: wingmanrank,
                wins: session.rankings.wingman.wins || 0,
                rankTypeId: 7,
                rankWindowStats: 0,
                rankIfWin: Math.min(wingmanrank + 1, 18),
                rankIfLose: Math.max(wingmanrank - 1, 1),
                rankIfTie: wingmanrank
            },
            {
                accountId: AccountId,
                rankId: dzrank,
                wins: session.rankings.dangerzone.wins || 0,
                rankTypeId: 10,
                rankWindowStats: 0,
                rankIfWin: Math.min(dzrank + 1, 18),
                rankIfLose: Math.max(dzrank - 1, 1), 
                rankIfTie: dzrank
            }
        ],
    };

    const CsWelcomeType1 = root.lookupType('CMsgConnectionStatus'); // CMsgCStrike15Welcome
    const gamedata1 = CsWelcomeType1.encode(csWelcome1).finish();

    const CsWelcomeType2 = root.lookupType('CMsgGCCStrike15_v2_MatchmakingGC2ClientHello');
    const gamedata2 = CsWelcomeType2.encode(csWelcome2).finish();

    sendProto(res, 4004, 'CMsgGCClientWelcome', {
        version: 13881,
        gameData: gamedata1,
        outofdate_subscribed_caches: [],
        uptodate_subscribed_caches: [],
        location: {
            latitude: 55.7558,
            longitude: 37.6173,
            country: "RU"
        },
        gameData2: gamedata2, // Buffer.alloc(0),
        rtime32GcWelcomeTimestamp: Math.floor(Date.now() / 1000),
        currency: 0,
        balance: 0,
        balanceUrl: "",
        txnCountryCode: "RU"
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, res, steamid) => {
//    const accountId = data?.account_id || 100000000; 
    const accountId = steamid;
    const session = sessions.get(accountId);

    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        return;
    }

    console.log(`[DEBUG] got Client2GCHello for id ${accountId}`);
    
    sendProto(res, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        accountId: accountId,
        ranking: {
            accountId: accountId,
            rankId: session.rankings.competitive.rank || 1,
            wins: session.rankings.competitive.wins || 0,
            rankTypeId: 6,
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
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, res, steamid) => {
//    const accountIds = data?.account_ids || [];
    const accountIds = steamid;
    const accountId = accountIds[0] || null;
    
    const tempId = `temp_1`;
    const session = sessions.get(tempId);
    
    if (!session) {
        console.log(`[ERROR] Session not found for ${tempId}`);
        return;
    }
    
    if (accountId) {
        session.accountId = accountId;
        sessions.delete(tempId);
        sessions.set(accountId, session);
        
        const oldPath = `${DATA_DIR}/${tempId}.json`;
        const newPath = `${DATA_DIR}/${accountId}.json`;
        if (fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
        }
    }
    
    console.log(`[HANDLER] Matchmaking Start for ${accountId || tempId}`);
    const gameType = data?.game_type || 0;
    
    if (session) {
        session.matchmaking = true;
        savePlayer(accountId || tempId);
    }

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [accountId || 100000000],
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

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, res) => {
    console.log('[HANDLER] Ping');
    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [100000000],
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

events.on('CMsgGCCStrike15_v2_GetEventFavorites_Request', (data, res, steamid) => {
    console.log('[HANDLER] GetEventFavorites');
    sendProto(res, 9203, 'CMsgGCCStrike15_v2_GetEventFavorites_Response', {
        allEvents: false,
        jsonFavorites: "{}",
        jsonFeatured: "{}"
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStop', (data, res, steamid) => {
    const accountId = steamid;
    const session = sessions.get(accountId);

    console.log(`[MATCHMAKING STOP] Received for ${accountId}`);

    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        return;
    }

    if (session.isInitiatedMMSearchStop) {
        console.log('[MATCHMAKING STOP] Already stopping, ignoring');
        return;
    }

    session.isInitiatedMMSearchStop = true;
    session.matchmaking = false;

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 2,
        waitingAccountIdSessions: [],
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

    session.isInitiatedMMSearchStop = false;
    savePlayer(accountId);
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, res, steamid) => {
    const accountId = steamid;
    const session = sessions.get(accountId);

    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        return;
    }

    console.log(`got Client2GCHello for id ${accountId}`);
    
    sendProto(res, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        accountId: accountId,
        ranking: {
            accountId: accountId,
            rankId: session.rankings.competitive.rank || 1,
            wins: session.rankings.competitive.wins || 0,
            rankTypeId: 6,
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
    });
});

events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, res, steamid) => {
    console.log('[RANK UPDATE] Received');
    
    const accountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!accountId) {
        console.log('[ERROR] No steamid received');
        return;
    }

    let session = sessions.get(accountId);
    if (!session) {
        console.log(`[ERROR] Session not found for ${accountId}`);
        session = loadPlayer(accountId);
        if (!session) {
            console.log(`[ERROR] No session on disk for ${accountId}`);
            return;
        }
        sessions.set(accountId, session);
    }
    
    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    
    const requestedRankTypeId = data?.rankings?.[0]?.rankTypeId || 6;

    console.log(`[RANK UPDATE] for ${accountId} for rank ${requestedRankTypeId}`);
    
    if (requestedRankTypeId === 6) {
        sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: [
                {
                    accountId: accountId,
                    rankId: competitiverank,
                    wins: session.rankings.competitive.wins || 0,
                    rankTypeId: 6,
                    rankWindowStats: 0,
                    rankIfWin: Math.min(competitiverank + 1, 18),
                    rankIfLose: Math.max(competitiverank - 1, 1),
                    rankIfTie: competitiverank
                }
            ]
        });
    } else {
        sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: [
                {
                    accountId: accountId,
                    rankId: wingmanrank,
                    wins: session.rankings.wingman.wins || 0,
                    rankTypeId: 7,
                    rankWindowStats: 0,
                    rankIfWin: Math.min(wingmanrank + 1, 18),
                    rankIfLose: Math.max(wingmanrank - 1, 1),
                    rankIfTie: wingmanrank
                },
                {
                    accountId: accountId,
                    rankId: dzrank,
                    wins: session.rankings.dangerzone.wins || 0,
                    rankTypeId: 10,
                    rankWindowStats: 0,
                    rankIfWin: Math.min(dzrank + 1, 18),
                    rankIfLose: Math.max(dzrank - 1, 1),
                    rankIfTie: dzrank
                }
            ]
        });
    }

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
                    events.emit(decoded.name, decoded.data, res, decoded.steamid);
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

const PORT = config.port;
const HOST = config.host;

server.listen(PORT, HOST, () => {
    console.log(`[Notification] Server running on ${HOST}:${PORT}`);
});