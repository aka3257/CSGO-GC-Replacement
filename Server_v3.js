const net = require('node:net');
const protobuf = require('protobufjs');
const fs = require('fs');

// required files

const options = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
};

function log(text) {
    const localTime = new Date().toLocaleString('ru-RU', options);
    console.log(`[${localTime}]: ${text}`)
}

const CONFIG_FILE = './config.json'
const PRICESHEET_FILE = './pricesheet.json'

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    log('[Notification] loaded config file!')
} catch (err) {
    log('[WARN] config file not found! creating default...');
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
    log('[Notification] created config file')
    log('[Advice] specify your ip in config file')
}

function getDefaultPriceSheet() {
    return {
        version: 1,
        items: {
            "community_31 Key": 249,
            "community_30 Key": 249,
            "community_29 Key": 249,
            "Name Tag": 199,
            "Weapon Case Key": 249,
            "Sticker Crate Key": 99,
            "casket": 199
        }
    };
}

function buildPriceSheetBinary(priceData) {
    const chunks = [];
    
    // Заголовок прайсшита
    chunks.push(0x0A); // field 1: version
    chunks.push(0x02); // varint length
    chunks.push(priceData.version || 1);
    
    // Items
    for (const [itemName, value] of Object.entries(priceData.items || {})) {
        let price;
        if (typeof value === 'number') {
            price = value;
        } else if (typeof value === 'object' && value !== null && value.price !== undefined) {
            price = value.price;
        } else {
            log(`[WARN] Invalid price for ${itemName}, skipping`);
            continue;
        }
        
        // Формат: 0x00 (subkey) + itemName + 0x02 (string) + price
        chunks.push(0x00);
        chunks.push(...Buffer.from(itemName + '\0'));
        chunks.push(0x02);
        chunks.push(...Buffer.from(price.toString() + '\0'));
    }
    
    chunks.push(0x0B); // Terminate
    return Buffer.from(chunks);
}

let gpricesheet;
try {
    const raw = fs.readFileSync(PRICESHEET_FILE, 'utf-8');
    gpricesheet = JSON.parse(raw);
    log('[Notification] loaded pricesheet file!');
} catch {
    log('[WARN] pricesheet file not found! creating default...');
    const def = getDefaultPriceSheet();
    fs.writeFileSync(PRICESHEET_FILE, JSON.stringify(def, null, 2));
    gpricesheet = def;
    log('[Notification] created pricesheet file');
}

const root = protobuf.loadSync([
    `${config.protoPath}/base_gcmessages.proto`,
    `${config.protoPath}/cstrike15_gcmessages.proto`,
    `${config.protoPath}/econ_gcmessages.proto`,
    `${config.protoPath}/engine_gcmessages.proto`,
    `${config.protoPath}/gcsdk_gcmessages.proto`,
    `${config.protoPath}/gcsystemmsgs.proto`,
    `${config.protoPath}/steammessages.proto`
]);

const GC_VER = 'v0.2'; //version of server
const DEVMODE = config.devmode; //debug mode
const DATA_DIR = config.PlayerData; //self-explanatory
const SERV_VER = config.serverVersion; //version that srcds requires
const SERV_IP = config.serverIp; //ip for srcds, not used at that moment

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (DEVMODE === true) {
    log('[Notification] GC started in debug mode')
} else {
    log('[Notification] GC started in normal mode')
}

// id dictionary

const IDict = {
    93: 'CMsgAccountDetails',
    94: 'CMsgAccountDetailsResponse',
    4004: 'CMsgClientWelcome',
    4005: 'CMsgGCServerWelcome',
    4006: 'CMsgClientHello',
    4007: 'CMsgGCServerHello',
    2500: 'CMsgStoreGetUserData',
    2501: 'CMsgGCStoreGetUserDataResponse',
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
    4009: 'CMsgConnectionStatus',
};

function getMessageNameById(id) {
    return IDict[id] || null;
}

const ReverseIDict = {};
for (const id in IDict) {
    ReverseIDict[IDict[id]] = Number(id);
}

// functions 

function getDefaultInventory(steamid) {
    const now = Math.floor(Date.now() / 1000);
    return [
        // Стартовые скины
        {
            id: steamid * 1000 + 1,
            accountId: steamid,
            defIndex: 7,    // AK-47
            quantity: 1,
            level: 1,
            quality: 0,
            inventory: 0,
            origin: 0,
            inUse: true,
            equippedState: [{ classId: 0, slotId: 1 }]
        },
        {
            id: steamid * 1000 + 2,
            accountId: steamid,
            defIndex: 60,   // M4A1-S
            quantity: 1,
            level: 1,
            quality: 0,
            inventory: 0,
            origin: 0,
            inUse: true,
            equippedState: [{ classId: 1, slotId: 0 }]
        },
        {
            id: steamid * 1000 + 3,
            accountId: steamid,
            defIndex: 42,   // Knife
            quantity: 1,
            level: 1,
            quality: 0,
            inventory: 0,
            origin: 0,
            inUse: true,
            equippedState: [{ classId: 0, slotId: 2 }, { classId: 1, slotId: 2 }]
        }
    ];
}

function sendProto(socket, msgType, protoName, object, steamid = 0) {
    try {
        const Proto = root.lookupType(protoName);
        const message = Proto.fromObject(object);
        const payload = Proto.encode(message).finish();

        const finalMsgType = (0x80000000 | msgType) >>> 0;
        
        // Создаём CMsgProtoBufHeader с валидным job_id_source
        const header = {
            job_id_source: 0, // ← не JobIdInvalid!
            job_id_target: -1, // ← JobIdInvalid
            eresult: 2,
        };
        const HeaderType = root.lookupType('CMsgProtoBufHeader');
        const headerBuffer = HeaderType.encode(HeaderType.fromObject(header)).finish();
        const headerSize = headerBuffer.length;

        const totalLen = 8 + headerSize + payload.length; // msgType (4) + header + payload
        const buffer = Buffer.alloc(4 + totalLen);
        
        buffer.writeUInt32LE(totalLen, 0);
        buffer.writeUInt32LE(finalMsgType, 4);
        buffer.writeUInt32LE(headerSize, 8); // ← правильный размер!
        headerBuffer.copy(buffer, 12);
        payload.copy(buffer, 12 + headerSize);

        log(`[SENT] ${protoName} (${finalMsgType}) ${buffer.length} bytes, totalLen=${totalLen}`);
        socket.write(buffer);
        return true;
    } catch (err) {
        console.error(`[${localTime}]: [ERROR] sendProto:`, err.message);
        return false;
    }
}

function getMSGdata(buffer) {
    try {
        // Пакет от форвардера: steamid (8 байт) + msgType (4 байта) + Protobuf-данные
        if (buffer.length < 12) {
            log(`[ERROR] Buffer too small`);
            return null;
        }
        const steamId = buffer.readBigUInt64LE(0);
        const AccountId = Number(steamId & 0xFFFFFFFFn);
        const msgId = buffer.readUInt32LE(8);
        const cleanMsgId = msgId & 0x7FFFFFFF;
        const messageName = getMessageNameById(cleanMsgId);

        // Protobuf-данные начинаются с 12-го байта
        const protoData = buffer.subarray(16);
        if (DEVMODE === true) {
            log(`[DEBUG] steamId: ${AccountId}, msgId: ${msgId}, cleanMsgId: ${cleanMsgId}, name: ${messageName}`);
            log(`[DEBUG] hex: ${buffer.toString('hex')}`);
        }
        if (!messageName) {
            log(`[ERROR] Unknown message: ${buffer.toString('hex')}`);
            return null;
        }
        const MessageType = root.lookupType(messageName);
        const decoded = MessageType.decode(protoData);
        return { name: messageName, steamid: AccountId, data: decoded };
    } catch (err) {
        console.error(`[${localTime}]: [ERROR] getMSGdata:`, err.message);
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

function uint32ToIp(uint32) {
    const octet1 = (uint32 >>> 24) & 0xFF;
    const octet2 = (uint32 >>> 16) & 0xFF;
    const octet3 = (uint32 >>> 8) & 0xFF;
    const octet4 = uint32 & 0xFF;
    return `${octet1}.${octet2}.${octet3}.${octet4}`;
}

function buildCacheSubscription_DEPRECATED(steamid, session, level = 1) {
    // Защита от undefined
    if (!session) session = { inventory: [], cmd: { friendly: 1, teaching: 2, leader: 3 } };
    if (!session.inventory) session.inventory = [];
    if (!session.cmd) session.cmd = { friendly: 1, teaching: 2, leader: 3 };

    const message = {
        version: 1575,
        ownerSoid: { type: 1, id: steamid },
        objects: []
    };

    // 1. Инвентарь (тип 1) — пустой для теста, но с правильным object_data (массив бинарных данных)
    const inventoryObject = {
        typeId: 1,  // ← snake_case!
        objectData: []
    };
    message.objects.push(inventoryObject);

    // 2. Данные профиля (тип 2, а не 4!)
    const personaData = {
        playerLevel: level,      // snake_case!
        elevatedState: false,
        commendation: {
            cmdFriendly: session.cmd.friendly || 1,
            cmdTeaching: session.cmd.teaching || 1,
            cmdLeader: session.cmd.leader || 1
        }
    };
    // Сериализуем в бинарный protobuf
    const PersonaType = root.lookupType('CSOPersonaDataPublic');
    const personaBuffer = PersonaType.encode(PersonaType.fromObject(personaData)).finish();

    const personaObject = {
        typeId: 2,  // ← исправлено!
        objectData: [personaBuffer]
    };
    message.objects.push(personaObject);

    // 3. Аккаунт (тип 7)
    const accountClient = {
        additionalBackpackSlots: 0,
        bonusXpTimestampRefresh: Math.floor(Date.now() / 1000),
        bonusXpUsedflags: 16,
        elevatedState: 2,    // Prime
        elevatedTimestamp: 2
    };
    const AccountType = root.lookupType('CSOEconGameAccountClient');
    const accountBuffer = AccountType.encode(AccountType.fromObject(accountClient)).finish();

    const accountObject = {
        type_id: 7,
        object_data: [accountBuffer]
    };
    message.objects.push(accountObject);

    // 4. Дефолтная экипировка (тип 43, а не 8!)
    const defaultEquips = [
        { account_id: steamid, item_definition: 60, class_id: 0, slot_id: 0 },
        { account_id: steamid, item_definition: 7, class_id: 0, slot_id: 1 },
        { account_id: steamid, item_definition: 60, class_id: 1, slot_id: 0 },
        { account_id: steamid, item_definition: 1, class_id: 1, slot_id: 1 },
        { account_id: steamid, item_definition: 42, class_id: 0, slot_id: 2 },
        { account_id: steamid, item_definition: 42, class_id: 1, slot_id: 2 }
    ];
    const DefaultEquipType = root.lookupType('CSOEconDefaultEquippedDefinitionInstanceClient');
    const defaultBuffers = defaultEquips.map(eq => 
        DefaultEquipType.encode(DefaultEquipType.fromObject(eq)).finish()
    );

    const defaultEquipObject = {
        type_id: 43,  // ← исправлено!
        object_data: defaultBuffers
    };
    message.objects.push(defaultEquipObject);

    return message;
}

function buildCacheSubscription(steamid, session, level = 1) {
    // Защита от undefined
    if (!session) session = { inventory: [], cmd: { friendly: 1, teaching: 2, leader: 3 } };
    if (!session.inventory) session.inventory = [];
    if (!session.cmd) session.cmd = { friendly: 1, teaching: 2, leader: 3 };

    const cache = {
        version: 1575,
        owner_soid: { type: 1, id: steamid },
        objects: []
    };

    // 1. Инвентарь
    const invObj = {
        type_id: 1,
        object_data: []
    };
    if (session.inventory.length > 0) {
        for (const item of session.inventory) {
            // Сериализуем как CSOEconItem
            const econItem = {
                id: item.id || Math.floor(Math.random() * 1000000000),
                account_id: steamid,
                inventory: item.inventory || 0,
                def_index: item.defIndex || 0,
                quantity: item.quantity || 1,
                level: item.level || 1,
                quality: item.quality || 0,
                flags: item.flags || 0,
                origin: item.origin || 0,
                custom_name: item.customName || "",
                custom_desc: item.customDesc || "",
                attribute: item.attribute || [],
                in_use: item.inUse || false,
                style: item.style || 0,
                original_id: item.originalId || 0,
                equipped_state: item.equippedState || [],
                rarity: item.rarity || 0
            };
            const EconItemType = root.lookupType('CSOEconItem');
            const buffer = EconItemType.encode(EconItemType.fromObject(econItem)).finish();
            invObj.object_data.push(buffer);
        }
    }
    cache.objects.push(invObj);

    // 2. Данные профиля
    const personaData = {
        player_level: level,
        elevated_state: true,
        commendation: {
            cmd_friendly: session.cmd.friendly || 1,
            cmd_teaching: session.cmd.teaching || 1,
            cmd_leader: session.cmd.leader || 1
        }
    };
    const PersonaType = root.lookupType('CSOPersonaDataPublic');
    const personaBuffer = PersonaType.encode(PersonaType.fromObject(personaData)).finish();
    cache.objects.push({
        type_id: 2,
        object_data: [personaBuffer]
    });

    // 3. Аккаунт
    const accountClient = {
        additional_backpack_slots: 0,
        bonus_xp_timestamp_refresh: Math.floor(Date.now() / 1000),
        bonus_xp_usedflags: 16,
        elevated_state: 5,
        elevated_timestamp: Math.floor(Date.now() / 1000)
    };
    const AccountType = root.lookupType('CSOEconGameAccountClient');
    const accountBuffer = AccountType.encode(AccountType.fromObject(accountClient)).finish();
    cache.objects.push({
        type_id: 7,
        object_data: [accountBuffer]
    });

    // 4. Дефолтная экипировка
    const defaultEquips = [
        { account_id: steamid, item_definition: 60, class_id: 0, slot_id: 0 },
        { account_id: steamid, item_definition: 7, class_id: 0, slot_id: 1 },
        { account_id: steamid, item_definition: 60, class_id: 1, slot_id: 0 },
        { account_id: steamid, item_definition: 1, class_id: 1, slot_id: 1 },
        { account_id: steamid, item_definition: 42, class_id: 0, slot_id: 2 },
        { account_id: steamid, item_definition: 42, class_id: 1, slot_id: 2 }
    ];
    const DefaultEquipType = root.lookupType('CSOEconDefaultEquippedDefinitionInstanceClient');
    const defaultBuffers = defaultEquips.map(eq =>
        DefaultEquipType.encode(DefaultEquipType.fromObject(eq)).finish()
    );
    cache.objects.push({
        type_id: 43,
        object_data: defaultBuffers
    });

    return cache;
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

    log(`[Notification] ClientHello from ${steamid}`)

    let session = loadPlayer(steamid);
    if (!session) {
        session = {
            accountId: steamid,
            rankings: {
                competitive: { rank: 1, wins: 0 },
                wingman: { rank: 1, wins: 0 },
                dangerzone: { rank: 1, wins: 0 }
            },
            playerLevel: 1,
            playerCurXp: 0,
            matchId: null,
            partyId: null,
            matchmaking: false,
            lastPing: Date.now(),
            isInitiatedMMSearchStop: false,
            vacBanned: 0,
            inventory: getDefaultInventory(steamid),
            cmd: { friendly: 1, teaching: 2, leader: 3 }
        };
        sessions.set(steamid, session);
        savePlayer(steamid);
    }

    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    const playerlevel = session.playerLevel || 1;
    const playercurxp = session.playerCurXp || 1;
    const cmdfriendly = session.cmd.friendly || 1;
    const cmdteaching = session.cmd.teaching || 1;
    const cmdleader = session.cmd.leader || 1;

    const csWelcome1 = {
        storeItemHash: 136617352,
        timeplayedconsecutively: 0,
        timeFirstPlayed: 1329845773,
        lastTimePlayed: 1680260376,
        lastIpAddress: 0,
        gscookieid: 0,
        uniqueid: 0
    };

    const csWelcome2 = {
        accountId: steamid,
        ongoingmatch: null,
        globalStats: {
            playersOnline: 2,
            serversOnline: 1,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 81387,
            mainPostUrl: "",
            requiredAppidVersion: 13881,
            pricesheetVersion: 1680057676,
            twitchStreamsVersion: 2,
            activeTournamentEventid: 20,
            activeSurveyId: 0,
            rtime32Cur: null, //Math.floor(Date.now() / 1000),
            requiredAppidVersion2: 13881
        },
        penaltySeconds: null,
        penaltyReason: null,
        vacBanned: 0,
        ranking: {
            accountId: steamid,
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
        medals: {
            displayItemsDefidx: 0,
            featuredDisplayItemDefidx: 0
        },
        myCurrentEvent: [],
        myCurrentEventTeams: [],
        myCurrentTeam: [],
        myCurrentTeamStages: [],
        surveyVote: 0,
        activity: {
            activity: 0
        },
        playerLevel: playerlevel,
        playerCurXp: playercurxp,
        playerXpBonusFlags: 0,
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
    }

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

    const cacheSubscription = buildCacheSubscription(steamid, session, session.playerLevel || 2);

    const socacheCheck = {
        version: 0,
        owner_soid: { type: 1, id: steamid }
    };

    const CsWelcomeType1 = root.lookupType('CMsgCStrike15Welcome');
    const gamedata1 = CsWelcomeType1.encode(csWelcome1).finish();

    const CsWelcomeType2 = root.lookupType('CMsgGCCStrike15_v2_MatchmakingGC2ClientHello');
    const gamedata2 = CsWelcomeType2.encode(csWelcome2).finish();

    const CsWelcomeType3 = root.lookupType('CMsgAccountDetails');
    const gamedata3 = CsWelcomeType3.encode(csWelcome3).finish();

    sendProto(socket, 4004, 'CMsgClientWelcome', {
        version: 0,
        gameData: gamedata1,
        outofdateSubscribedCaches: [cacheSubscription],
//        uptodateSubscribedCaches: [socacheCheck],
        location: {
            latitude: 65.0133006,
            longitude: 25.4646212,
            country: "FI"
        },
        gameData2: gamedata2,
        rtime32GcWelcomeTimestamp: Math.floor(Date.now() / 1000),
        currency: 2,
        balance: 0,
        balanceUrl: "",
        txnCountryCode: "FI",
    }, steamid);

    sendProto(socket, 9110, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello', {
        accountId: steamid,
        ongoingmatch: null,
        globalStats: {
            playersOnline: 2,
            serversOnline: 1,
            playersSearching: 1,
            serversAvailable: 1,
            ongoingMatches: 0,
            searchTimeAvg: 81387,
            mainPostUrl: "",
            requiredAppidVersion: 13881,
            pricesheetVersion: 1680057676,
            twitchStreamsVersion: 2,
            activeTournamentEventid: 20,
            activeSurveyId: 0,
            rtime32Cur: null, //Math.floor(Date.now() / 1000),
            requiredAppidVersion2: 13881
        },
        penaltySeconds: null,
        penaltyReason: null,
        vacBanned: 0, //0 - clean, 1 - vac, 2 - game ban
        ranking: {
            accountId: steamid,
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
        medals: {
            displayItemsDefidx: 0,
            featuredDisplayItemDefidx: 0
        },
        myCurrentEvent: [],
        myCurrentEventTeams: [],
        myCurrentTeam: [],
        myCurrentTeamStages: [],
        surveyVote: 0,
        activity: {
            activity: 0
        },
        playerLevel: playerlevel,
        playerCurXp: playercurxp,
        playerXpBonusFlags: 0,
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
    }, steamid);

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
    }, steamid);

    sendProto(socket, 4009, 'CMsgConnectionStatus', {
        status: 0,
        clientSessionNeed: 0,
        queuePosition: 0,
        queueSize: 0,
        waitSeconds: 0,
        estimatedWaitSecondsRemaining: 0 
    }, steamid); 

});

events.on('CMsgStoreGetUserData', (data, socket, steamid) => {
    log(`[Notification] StoreGetUserData from ${steamid}`);

    const priceSheetBinary = buildPriceSheetBinary(gpricesheet);

    sendProto(socket, 2501, 'CMsgStoreGetUserDataResponse', {
        result: 1,
        priceSheetVersion: gpricesheet.version || 1,
        priceSheet: priceSheetBinary
    }, steamid)
})

events.on('CMsgGCCStrike15_v2_MatchmakingStart', (data, socket, steamid) => {

    log(`[HANDLER] MatchmakingStart from ${steamid}`);
    
    let session = loadPlayer(steamid);
    const gameType = data?.game_type || 0;
    
    if (session) {
        session.matchmaking = true;
        savePlayer(steamid);
    }

    sendProto(socket, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [steamid || 100000000],
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
    }, steamid);
});

events.on('CMsgGCCStrike15_v2_MatchmakingClient2ServerPing', (data, socket, steamid) => {

    const gameType = data?.game_type || 0;

    log(`[HANDLER] MatchmakingClient2ServerPing from ${steamid}`);

    sendProto(socket, 9104, 'CMsgGCCStrike15_v2_MatchmakingGC2ClientUpdate', {
        matchmaking: 1,
        waitingAccountIdSessions: [steamid],
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
    }, steamid);
});

events.on('CMsgGCCStrike15_v2_GetEventFavorites_Request', (data, socket, steamid) => {
    log('[HANDLER] GetEventFavorites');
    sendProto(socket, 9203, 'CMsgGCCStrike15_v2_GetEventFavorites_Response', {
        allEvents: false,
        jsonFavorites: null,
        jsonFeatured: null
    }, steamid);
});

events.on('CMsgGCCStrike15_v2_MatchmakingStop', (data, socket, steamid) => {

    log(`[HANDLER] MatchmakingStop from ${steamid}`);

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
    }, steamid);

    savePlayer(steamid);
});


events.on('CMsgGCCStrike15_v2_ClientGCRankUpdate', (data, socket, steamid) => {

    let session = sessions.get(steamid);
    if (!session) {
        log(`[ERROR] Session not found for ${steamid}`);
        session = loadPlayer(steamid);
        if (!session) {
            log(`[ERROR] No session on disk for ${steamid}`);
            return;
        }
        sessions.set(steamid, session);
    }
    
    const competitiverank = session.rankings.competitive.rank || 1;
    const wingmanrank = session.rankings.wingman.rank || 1;
    const dzrank = session.rankings.dangerzone.rank || 1;
    
    const requestedRankTypeId = data?.rankings?.[0]?.rankTypeId || 6;

    log(`[RANK UPDATE] for ${steamid} for rank ${requestedRankTypeId}`);
    
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
        }, steamid);
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
        }, steamid);
    }
});

events.on('CMsgGCCStrike15_v2_Party_Register', (data, socket, steamid) => {
    log('[PARTY] Register');
    sendProto(socket, 9190, 'CMsgGCCStrike15_v2_Party_Unregister', {}, steamid);
});

events.on('CMsgGCCStrike15_v2_ClientRequestJoinServerData', (data, socket, steamid) => {
    
    const AccountId = steamid ? Number(BigInt(steamid) & 0xFFFFFFFFn) : 0;
    if (!AccountId) {
        log(`[HANDLER] ClientRequestJoinServerData from unknown id`);
        return;
    } else {
            log(`[HANDLER] ClientRequestJoinServerData from ${AccountId}`);
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
                matchId: 87239,
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
    }, steamid);
})

// server body

const server = net.createServer((socket) => {
    log(`[SOCKET] connect from ${socket.remoteAddress}:${socket.remotePort}`);
    const chunks = [];

    socket.on('data', (data) => {
        chunks.push(data);
    });

    socket.on('end', () => {
        const packet = Buffer.concat(chunks);
        const decoded = getMSGdata(packet);
        if (decoded) {
            events.emit(decoded.name, decoded.data, socket, decoded.steamid);
        }
        log('[SOCKET] end on server');
    });

    socket.on('close', () => {
        log(`[SOCKET] closed by client ${socket.remoteAddress}:${socket.remotePort}`);
    })

    socket.on('error', (err) => {
        log(`[ERROR] socket: ${err.message}`);
    });
});

// params

const PORT = config.port;
const HOST = config.host;

server.listen(PORT, HOST, () => {
    log(`[Notification] GC ${GC_VER} running on ${HOST}:${PORT}`);
});
