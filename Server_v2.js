const http = require('http');
const protobuf = require('protobufjs');
const fs = require('fs');

// config settings

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
        devmode: false,
        serverVersion: '13881',
        serverIp: '0.0.0.0'
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

const DEVMODE = config.devmode; //debug mode
const DATA_DIR = config.PlayerData; //self-explanatory
const SERV_VER = config.serverVersion; //version that srcds requires
const SERV_IP = config.serverIp; //ip for srcds, not used at that moment

if (DEVMODE === true) {
    console.log('[Notification] GC started in debug mode')
} else {
    console.log('[Notification] GC started in normal mode')
}

// id dictionary

const IDict = {
    93: 'CMsgAccountDetails',
    94: 'CMsgAccountDetailsResponse',
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
    9164: 'CMsgGCCStrike15_v2_ClientRequestJoinServerData',
    4009: 'CMsgGCClientConnectionStatus',
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
            playerLevel: 1,
            playerCurXp: 0,
            matchId: null,
            partyId: null,
            matchmaking: false,
            lastPing: Date.now(),
            isInitiatedMMSearchStop: false,
            vacBanned: 0,
            inventory: [],
            cmd: {
                friendly: 1,
                teaching: 2,
                leader: 3
            },
            vacBanned: 0
        };
        savePlayer(accountId, session);
    };
    sessions.set(accountId, session);
    return { accountId, session };
}

function uint32ToIp(uint32) {
    const octet1 = (uint32 >>> 24) & 0xFF;
    const octet2 = (uint32 >>> 16) & 0xFF;
    const octet3 = (uint32 >>> 8) & 0xFF;
    const octet4 = uint32 & 0xFF;
    return `${octet1}.${octet2}.${octet3}.${octet4}`;
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

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] ClientHello from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] ClientHello from ${AccountId}`);
    };

//    const accountId = Number(BigInt(steamid) & 0xFFFFFFFFn);
//    const accId = getOrCreateSession(steamid)
//    console.log(`[HANDLER] accountId: ${AccountId}`);

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
            playerLevel: 1,
            playerCurXp: 0,
            matchId: null,
            partyId: null,
            matchmaking: false,
            lastPing: Date.now(),
            isInitiatedMMSearchStop: false,
            vacBanned: 0,
            inventory: [],
            cmd: {
                friendly: 1,
                teaching: 2,
                leader: 3
            },
            vacBanned: 0
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
    const cmdfriendly = session.cmd.friendly || 1;
    const cmdteaching = session.cmd.teaching || 1;
    const cmdleader = session.cmd.leader || 1;

    const csWelcome1 = {
        storeItemHash: 0,
        timeplayedconsecutively: 0,
        timeFirstPlayed: Math.floor(Date.now() / 1000),
        lastTimePlayed: Math.floor(Date.now() / 1000),
        lastIpAddress: 0,
        gscookieid: Math.floor(Math.random() * 1000000000),
        uniqueid: Math.floor(Math.random() * 1000000000)
////        status: 0,
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
        vacBanned: 0,
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
            cmdFriendly: cmdfriendly,
            cmdTeaching: cmdteaching,
            cmdLeader: cmdleader
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

    const csWelcome3 = {
        valid: true,
        publicProfile: true,
        publicInventory: true,
        vacBanned: false,
        cyberCafe: false,
        schoolAccount: false,
        freeTrialAccount: false,
        subscribed: true,
        lowViolence: false,
        limited: false,
        trusted: true,
        accountLocked: false,
        communityBanned: false,
        eligibleForCommunityMarket: true
    };

    const connectstatus = {
        status: 0,
    }

    const CsWelcomeType1 = root.lookupType('CMsgCStrike15Welcome');
    const gamedata1 = CsWelcomeType1.encode(csWelcome1).finish();

    const CsWelcomeType2 = root.lookupType('CMsgGCCStrike15_v2_MatchmakingGC2ClientHello');
    const gamedata2 = CsWelcomeType2.encode(csWelcome2).finish();

    const CsWelcomeType3 = root.lookupType('CMsgAccountDetails');
    const gamedata3 = CsWelcomeType3.encode(csWelcome3).finish();

    const CsWelcomeType4 = root.lookupType('CMsgGCClientConnectionStatus');
    const gamedata4 = CsWelcomeType4.encode(connectstatus).finish();

    sendProto(res, 4004, 'CMsgGCClientWelcome', {
        version: 1575,
        gameData: gamedata1,
        outofdate_subscribed_caches: [],
        uptodate_subscribed_caches: [],
        location: {
            latitude: 55.7558,
            longitude: 37.6173,
            country: "RU"
        },
        gameData2: Buffer.concat([gamedata2, gamedata3, gamedata4]),
        rtime32GcWelcomeTimestamp: Math.floor(Date.now() / 1000),
        currency: 0,
        balance: 0,
        balanceUrl: "",
        txnCountryCode: "RU",
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, res, steamid) => {

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingClient2GCHello from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingClient2GCHello from ${AccountId}`);
    };

    let session = loadPlayer(AccountId);

    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    const playerlevel = session.playerLevel || 1;
    const playercurxp = session.playerCurXp || 1;
    const cmdfriendly = session.cmd.friendly || 1;
    const cmdteaching = session.cmd.teaching || 1;
    const cmdleader = session.cmd.leader || 1;
    
    sendProto(res, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
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
        vacBanned: 0,
        ranking: {
            accountId: AccountId,
            rankId: competitiverank,
            wins: session.rankings.competitive.wins || 0,
            rankTypeId: 6,
            rankWindowStats: 0,
            rankIfWin: Math.min(competitiverank + 1, 18),
            rankIfLose: Math.max(competitiverank - 1, 1),
            rankIfTie: competitiverank
        }, 
        commendation: {
            cmdFriendly: cmdfriendly,
            cmdTeaching: cmdteaching,
            cmdLeader: cmdleader
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
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, res, steamid) => {

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingStart from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingStart from ${AccountId}`);
    };
    
    let session = loadPlayer(AccountId);
    const gameType = data?.game_type || 0;
    
    if (session) {
        session.matchmaking = true;
        savePlayer(AccountId);
    }

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [AccountId || 100000000],
        globalStats: {
            playersOnline: 2,
            serversOnline: 1,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 30,
            requiredAppidVersion: 1575,
            rtime32Cur: Math.floor(Date.now() / 1000)
        },
        notes: [
            {
                type: gameType,
                regionId: 0,
                regionR: 0,
                distance: 0
            }
        ]
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, res, steamid) => {

    const gameType = data?.game_type || 0;

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingClient2ServerPing from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingClient2ServerPing from ${AccountId}`);
    };

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [100000000],
        globalStats: {
            playersOnline: 2,
            serversOnline: 1,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 30,
            requiredAppidVersion: 1575,
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
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingStop from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingStop from ${AccountId}`);
    };

    sendProto(res, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 0,
        waitingAccountIdSessions: [],
        globalStats: {
            playersOnline: 2,
            serversOnline: 0,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 30,
            requiredAppidVersion: 1575,
            rtime32Cur: Math.floor(Date.now() / 1000)
        },
        notes: []
    });

    savePlayer(AccountId);
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2GCHello', (data, res, steamid) => {
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingClient2GCHello from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingClient2GCHello from ${AccountId}`);
    };

    let session = loadPlayer(AccountId);
    
    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    const playerlevel = session.playerLevel || 1;
    const playercurxp = session.playerCurXp || 1;
    const cmdfriendly = session.cmd.friendly || 1;
    const cmdteaching = session.cmd.teaching || 1;
    const cmdleader = session.cmd.leader || 1;

    sendProto(res, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        accountId: AccountId,
        globalStats: {
            playersOnline: 2,
            serversOnline: 0,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 30,
            requiredAppidVersion: 1575,
            rtime32Cur: Math.floor(Date.now() / 1000)
        },
        vacBanned: 0,
        ranking: {
            accountId: AccountId,
            rankId: competitiverank,
            wins: session.rankings.competitive.wins || 0,
            rankTypeId: 6,
            rankWindowStats: 0,
            rankIfWin: Math.min(competitiverank + 1, 18),
            rankIfLose: Math.max(competitiverank - 1, 1),
            rankIfTie: competitiverank
        }, 
        commendation: {
            cmdFriendly: cmdfriendly,
            cmdTeaching: cmdteaching,
            cmdLeader: cmdleader
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
        ]
    });
});

events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, res, steamid) => {
    
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[RANK UPDATE] Received from unknown id`);
        return;
    } else {
            console.log(`[RANK UPDATE] Received from ${AccountId}`);
    };

    let session = sessions.get(AccountId);
    if (!session) {
        console.log(`[ERROR] Session not found for ${AccountId}`);
        session = loadPlayer(AccountId);
        if (!session) {
            console.log(`[ERROR] No session on disk for ${AccountId}`);
            return;
        }
        sessions.set(AccountId, session);
    }
    
    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    
    const requestedRankTypeId = data?.rankings?.[0]?.rankTypeId || 6;

    console.log(`[RANK UPDATE] for ${AccountId} for rank ${requestedRankTypeId}`);
    
    if (requestedRankTypeId === 6) {
        sendProto(res, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: [
                {
                    accountId: AccountId,
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
            ]
        });
    }

});

events.on('CMsgGCCStrike15_v2_Party_Register', (data, res, steamid) => {
    console.log('[PARTY] Register');
    sendProto(res, 9190, 'CMsgGCCStrike15_v2_Party_Unregister', {});
});

events.on('CMsgGCCStrike15_v2_ClientRequestJoinServerData', (data, res, steamid) => {
    
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] ClientRequestJoinServerData from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] ClientRequestJoinServerData from ${AccountId}`);
    };

    let session = loadPlayer(AccountId);

    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    const playerlevel = session.playerLevel || 1;
    const playercurxp = session.playerCurXp || 1;
    const cmdfriendly = session.cmd.friendly || 1;
    const cmdteaching = session.cmd.teaching || 1;
    const cmdleader = session.cmd.leader || 1;

    const readableIp = uint32ToIp(data.serverIp)

    sendProto(res, 9164, 'CMsgGCCStrike15_v2_ClientRequestJoinServerData', {
        version: data.version,
        accountId: data.accountId,
        serverid: data.serverid,
        serverIp: data.serverIp,
        serverPort: data.serverPort,
        res: {
            serverid: data.serverid,
            directUdpIp: data.serverIp,
            directUdpPort: data.serverPort,
            reservationid: Math.floor(Math.random() * 1000000),
            reservation: {
                accountIds: [AccountId],
                gameType: 2,
                matchId: 1488,
                serverVersion: SERV_VER,
                rankings: [
                    {
                        accountId: AccountId,
                        rankId: competitiverank,
                        wins: session.rankings.competitive.wins || 0,
                        rankTypeId: 6,
                        rankWindowStats: 0,
                        rankIfWin: Math.min(competitiverank + 1, 18),
                        rankIfLose: Math.max(competitiverank - 1, 1),
                        rankIfTie: competitiverank
                    },
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
                encryptionKey: Math.floor(Math.random() * 1000000)
            },
            map: "de_lake",
            serverAddress: `${readableIp}:${data.serverPort}`
        }
    })
})

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
    console.log(`[Notification] GC running on ${HOST}:${PORT}`);
});