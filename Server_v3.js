const net = require('node:net');
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
    `${config.protoPath}/base_gcmessages.proto`,
    `${config.protoPath}/cstrike15_gcmessages.proto`,
    `${config.protoPath}/econ_gcmessages.proto`,
    `${config.protoPath}/engine_gcmessages.proto`,
    `${config.protoPath}/gcsdk_gcmessages.proto`,
    `${config.protoPath}/gcsystemmsgs.proto`
]);

const DEVMODE = config.devmode; //debug mode
const DATA_DIR = config.PlayerData; //self-explanatory
const SERV_VER = config.serverVersion; //version that srcds requires
const SERV_IP = config.serverIp; //ip for srcds, not used at that moment

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (DEVMODE === true) {
    console.log('[Notification] GC started in debug mode')
} else {
    console.log('[Notification] GC started in normal mode')
}

// id dictionary

const IDict = {
    93: 'CMsgAccountDetails',
    94: 'CMsgAccountDetailsResponse',
    4004: 'CMsgClientWelcome',
    4005: 'CMsgGCServerWelcome',
    4006: 'CMsgClientHello',
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

function sendProto(socket, msgType, protoName, object) {
    try {
        if (DEVMODE === true) {
            console.log('[DEBUG] Sent object:', JSON.stringify(object, null, 2));
        }
        const Proto = root.lookupType(protoName);
        const message = Proto.fromObject(object);
        const payload = Proto.encode(message).finish();
        const finalMsgType = (0x80000000 | msgType) >>> 0;
        const buffer = Buffer.alloc(4 + payload.length);
        buffer.writeUInt32LE(msgType, 0); // вместо finalMsgType
        payload.copy(buffer, 4);
        console.log(`[DEBUG] Sending ${buffer.length} bytes`);
        socket.write(buffer);
        console.log(`[SENT] ${protoName} (${finalMsgType})`);
        return true;
    } catch (err) {
        console.error(`[ERROR] sendProto:`, err.message);
        socket.destroy()
        return false;
    }
}

function getMSGdata(buffer) {
    try {
        if (buffer.length < 16) {
            console.log('[ERROR] Buffer too small');
            return null;
        }
        const steamId = buffer.readBigUInt64LE(0);
        const AccountId = steamId ? Number(BigInt(steamId) & 0xFFFFFFFFn) : 0;
        const msgId = buffer.readUInt32LE(8);
        const cleanMsgId = msgId & 0x7FFFFFFF;
        const messageName = getMessageNameById(cleanMsgId);
        const protoData = buffer.subarray(20);

        console.log(`[DEBUG] steamId: ${AccountId}, msgId: ${msgId}, cleanMsgId: ${cleanMsgId}, name: ${messageName}`);
        console.log(`[DEBUG] protoData length: ${protoData.length}, hex: ${protoData.toString('hex').slice(0, 50)}...`);

        if (!messageName) {
            console.log('[ERROR] Unknown message');
            return null;
        }
        const MessageType = root.lookupType(messageName);
        const decoded = MessageType.decode(protoData);
        return { name: messageName, steamid: AccountId, data: decoded };
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

function sendWithDelay(socket, msgType, protoName, object, delay = 100) {
    setTimeout(() => {
        sendProto(socket, msgType, protoName, object);
    }, delay);
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

    emit(eventName, data, socket, steamid) {
        if (this.handlers.has(eventName)) {
            for (const handler of this.handlers.get(eventName)) {
                handler(data, socket, steamid);
            }
            return true;
        }
        return false;
    }
}

const events = new EventBus();

// events(reqs from client)

const sessions = new Map();

events.on('CMsgClientHello', (data, socket, steamid) => {

    console.log(`[Notification] ClientHello from ${steamid}`)

    let session = loadPlayer(steamid);
    if (!session) {
        session = {
            accountId: steamid,
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
        sessions.set(steamid, session)
        savePlayer(steamid);

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
        timeFirstPlayed: 0,
        lastTimePlayed: 0,
        lastIpAddress: 0,
        gscookieid: 1488,
        uniqueid: 1488
    };

    const csWelcome3 = {
        valid: true,
        accountName: steamid,
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
        package: 0,
        accountLocked: false,
        communityBanned: false,
        eligibleForCommunityMarket: true
    };

    const socacheSubscribed = {
        objects: [
            {
                type_id: 1,
                object_data: []
            }
        ],
        version: 1575,
        owner_soid: {
            type: 1,
            id: steamid
        }
    };

    const socacheCheck = {
        version: 1575,
        owner_soid: {
            type: 1,
            id: steamid
        }
    };

    const ConnectionStatus = {
        status: 0,
        clientSessionNeed: 0,
        queuePosition: 0,
        queueSize: 0,
        waitSeconds: 0,
        estimatedWaitSecondsRemaining: 0
    };

    const CsWelcomeType1 = root.lookupType('CMsgCStrike15Welcome');
    const gamedata1 = CsWelcomeType1.encode(csWelcome1).finish();

    const CsWelcomeType3 = root.lookupType('CMsgAccountDetails');
    const gamedata3 = CsWelcomeType3.encode(csWelcome3).finish();

    const CsWelcomeType4 = root.lookupType('CMsgConnectionStatus');
    const gamedata4 = CsWelcomeType4.encode(ConnectionStatus).finish();

    sendProto(socket, 4004, 'CMsgClientWelcome', {
        version: 1575,
        gameData: gamedata1,
        outofdateSubscribedCaches: [socacheSubscribed],
        uptodateSubscribedCaches: [socacheCheck],
        location: {
            latitude: 55.7558,
            longitude: 37.6173,
            country: "RU"
        },
        gameData2: [], // Buffer.concat([gamedata1, gamedata2, gamedata3, gamedata4]),
        rtime32GcWelcomeTimestamp: Math.floor(Date.now() / 1000),
        currency: 0,
        balance: 0,
        balanceUrl: "",
        txnCountryCode: "RU",
    });
    sendWithDelay(socket, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        accountId: steamid,
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
        vacBanned: 0,
        ranking: {
            accountId: steamid,
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
        medals: [],
        playerLevel: playerlevel,
        playerCurXp: playercurxp,
        rankings: [
            {
                accountId: steamid,
                rankId: wingmanrank,
                wins: session.rankings.wingman.wins || 0,
                rankTypeId: 7,
                rankWindowStats: 0,
                rankIfWin: Math.min(wingmanrank + 1, 18),
                rankIfLose: Math.max(wingmanrank - 1, 1),
                rankIfTie: wingmanrank
            },
            {
                accountId: steamid,
                rankId: dzrank,
                wins: session.rankings.dangerzone.wins || 0,
                rankTypeId: 10,
                rankWindowStats: 0,
                rankIfWin: Math.min(dzrank + 1, 18),
                rankIfLose: Math.max(dzrank - 1, 1), 
                rankIfTie: dzrank
            }
        ]
    }, 100);
    sendProto(socket, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
        rankings: [
            {
                accountId: steamid,
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
    sendProto(socket, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
        rankings: [
            {
                accountId: steamid,
                rankId: wingmanrank,
                wins: session.rankings.wingman.wins || 0,
                rankTypeId: 7,
                rankWindowStats: 0,
                rankIfWin: Math.min(wingmanrank + 1, 18),
                rankIfLose: Math.max(wingmanrank - 1, 1),
                rankIfTie: wingmanrank
            },
            {
                accountId: steamid,
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
//    sendProto(socket, 4009, 'CMsgConnectionStatus', {
//        status: 0,
//        clientSessionNeed: 0
//    });
    setTimeout(() => {
        socket.end()
    }, 300)
});

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, socket, steamid) => {

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

    sendProto(socket, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
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

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, socket, steamid) => {

    const gameType = data?.game_type || 0;

    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingClient2ServerPing from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingClient2ServerPing from ${AccountId}`);
    };

    sendProto(socket, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
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

events.on('CMsgGCCStrike15_v2_GetEventFavorites_Request', (data, socket, steamid) => {
    console.log('[HANDLER] GetEventFavorites');
    sendProto(socket, 9203, 'CMsgGCCStrike15_v2_GetEventFavorites_Response', {
        allEvents: false,
        jsonFavorites: "{}",
        jsonFeatured: "{}"
    });
});

events.on('CMsgGCCStrike15_v2_MatchmakingStop', (data, socket, steamid) => {
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        console.log(`[HANDLER] MatchmakingStop from unknown id`);
        return;
    } else {
            console.log(`[HANDLER] MatchmakingStop from ${AccountId}`);
    };

    sendProto(socket, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
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
        notes: [{
            prime: true
        }]
    });

    savePlayer(AccountId);
});


events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, socket, steamid) => {

    let session = sessions.get(steamid);
    if (!session) {
        console.log(`[ERROR] Session not found for ${steamid}`);
        session = loadPlayer(steamid);
        if (!session) {
            console.log(`[ERROR] No session on disk for ${steamid}`);
            return;
        }
        sessions.set(steamid, session);
    }
    
    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    
    const requestedRankTypeId = data?.rankings?.[0]?.rankTypeId || 6;

    console.log(`[RANK UPDATE] for ${steamid} for rank ${requestedRankTypeId}`);
    
    if (requestedRankTypeId === 6) {
        sendProto(socket, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: [
                {
                    accountId: steamid,
                    rankId: competitiverank,
                    wins: session.rankings.competitive.wins || 0,
                    rankTypeId: 6,
                    rankWindowStats: 0,
                    rankIfWin: Math.min(competitiverank + 1, 18),
                    rankIfLose: Math.max(competitiverank - 1, 1),
                    rankIfTie: competitiverank
                },
            ]
        });
    } else {
        sendProto(socket, 9194, 'CMsgGCCStrike15_v2_ClientGCRankUpdate', {
            rankings: [
                {
                    accountId: steamid,
                    rankId: wingmanrank,
                    wins: session.rankings.wingman.wins || 0,
                    rankTypeId: 7,
                    rankWindowStats: 0,
                    rankIfWin: Math.min(wingmanrank + 1, 18),
                    rankIfLose: Math.max(wingmanrank - 1, 1),
                    rankIfTie: wingmanrank
                },
                {
                    accountId: steamid,
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
    socket.end()
});

events.on('CMsgGCCStrike15_v2_Party_Register', (data, socket, steamid) => {
    console.log('[PARTY] Register');
    sendProto(socket, 9190, 'CMsgGCCStrike15_v2_Party_Unregister', {});
});

events.on('CMsgGCCStrike15_v2_ClientRequestJoinServerData', (data, socket, steamid) => {
    
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

    sendProto(socket, 9164, 'CMsgGCCStrike15_v2_ClientRequestJoinServerData', {
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
                encryptionKey: Math.floor(Math.random() * 1000000),
                encryptionKeyPub: Math.floor(Math.random() * 1000000),
                whitelist: [],
                preMatchData: {
                    teamStats: [],
                    draft: [],
                    stats: [],
                    wins: 0
                }
            },
            map: "de_lake",
            serverAddress: `${readableIp}:${data.serverPort}`
        }
    })
})

// server body

// Вместо http.createServer
const server = net.createServer((socket) => {
    console.log('Клиент подключился');

    socket.on('data', (data) => {
        const decoded = getMSGdata(data);
        if (decoded) {
            events.emit(decoded.name, decoded.data, socket, decoded.steamid);
        }
    });

    socket.on('end', () => {
        console.log('Клиент отключился');
    });
});

// params

const PORT = config.port;
const HOST = config.host;

server.listen(PORT, HOST, () => {
    console.log(`[Notification] GC running on ${HOST}:${PORT}`);
});
