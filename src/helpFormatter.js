const {eachLimit} = require('async');
const makeError = require("make-error");
const JSZip = require('jszip');
const { createInterface } = require('readline');
const { once } = require('events');
const utils = require('./utils');
const Cache = require('./cache');

const NotInGuildError = makeError('NotInGuildError');

const gameDataVersionRegex = new RegExp('^[0-9]+\.[0-9]+\.[0-9]+\:(.*)');
const gameDataListRegex = new RegExp('(.*)List$');

const INCLUDE_PVE_UNITS = true;

const DEFAULT_OPTIONS = {
  format: true,     // emulate .help formatting- required to enable other options
  structure: false, // return types of fields instead of data
  project: {},      // return a subset of the fields
  enums: false,     // return string representation of enum values. much slower / bigger
  match: {},        // for gameData, filters the data before returning it
};

const FLAT_STATS = [
  1,  // health
  5,  // speed
  28, // prot
  41, // offense
  42  // defense
];

function isStringEqual(a, b) {
  return (a && b && (a.localeCompare(b) == 0));
}

const processLocalizationLine = (line) => {
  if (line.startsWith('#')) return;
  let [ key, val ] = line.split(/\|/g).map(s => s.trim());
  if (!key || !val) return;
  return [key, val];
}

const processStreamByLine = async (fileStream) => {
  const langMap = {};

  try {
    const rl = createInterface({
      input: fileStream,
    });

    rl.on('line', (line) => {
      const result = processLocalizationLine(line);
      if (result) {
        const [key, val] = result;
        langMap[key] = val;
      }
    });

    await once(rl, 'close');
  } catch (err) {
    console.error(err);
  }

  return langMap;
};

const processFileContentsByLine = (content) => {
  const langMap = {};

  let lines = content.split(/\n/g);
  //Iterate each line and build language index
  for (let i = 0; i < lines.length; i++) {
    const result = processLocalizationLine(lines[i]);
    if (result) {
      const [key, val] = result;
      langMap[localizationMap[key]] = val;
    }
  }

  return langMap;
}

module.exports = class HelpFormatter {
  constructor(options) {
    this.comlinkStub = options.comlinkStub;
    this.concurrentPlayers = options.concurrentPlayers;
    this.concurrentGuilds = options.concurrentGuilds;
    this.languages = (options.languages.toUpperCase()).split(',');
    this.noLocalization = (options.noLocalization && options.noLocalization === "true") ? true : false;
    this.useSegments = (options.useSegments && options.useSegments === "true") ? true : false;
    this.useUnzip = (options.useUnzip && options.useUnzip === "true") ? true : false;
    this.updateInterval = options.updateInterval || 5; // in minutes
    this.dataPath = options.dataPath;

    this._playerCache = new Cache(options.playerCacheTime);
    this._unitMap = {};
    this._equipMap = {};
    this._skillMap = {};
    this._modMap = {};
    this._version = {};
    this._langMap = {};
  }

  async init() {
    try {
      console.debug(`Loading and verifying game data...`);
      const localizationVersion = await this.readFile('localizationVersion');
      const gameVersion = await this.readFile('gameDataVersion');
      this._version = {
        language: localizationVersion.versionString,
        game: gameVersion.versionString,
        gameFiles: gameVersion.files
      };

      this._unitMap = await this.readFile('unitMap');
      this._equipMap = await this.readFile('equipMap');
      this._skillMap = await this.readFile('skillMap');
      this._modMap = await this.readFile('modMap');
      for await (const language of this.languages) {
        console.debug(`Reading language data file: ${language}`);
        try {
          const lang = await this.readFile(language);
          if (lang.version === localizationVersion.versionString) {
            this._langMap[language] = lang.data;
          } else {
            throw new Error(`Language data version mismatched: ${language}`);
          }
        } catch(e) {
          throw(e);
        }
      }
    } catch(error) {
      console.debug(`Encountered an error loading the version data: ${error.message}`);
      try {
        const force = true;
        await this.updateCheck(null, null, force);
      } catch(e) {
        throw(e);
      }
    }
  }

  async _updateHook(callback) {
    let version;

    try {
      version = await this.comlinkStub.getMetaData();
      this._enablePolling(callback, version);
    } catch(error) {
      throw(error);
    }

    return {
      latestGamedataVersion: version.latestGamedataVersion,
      latestLocalizationBundleVersion: version.latestLocalizationBundleVersion
    };
  }

  _versionCheck(oldVersion, newVersion) {
    let updated = false;

    if (!isStringEqual(oldVersion.latestGamedataVersion, newVersion.latestGamedataVersion)) {
      updated = true;
      oldVersion.latestGamedataVersion = newVersion.latestGamedataVersion;
    }

    if (!isStringEqual(oldVersion.latestLocalizationBundleVersion, newVersion.latestLocalizationBundleVersion)) {
      updated = true;
      oldVersion.latestLocalizationBundleVersion = newVersion.latestLocalizationBundleVersion;
    }

    return updated;
  };

  _handleVersionNotification(version, newVersion, callback) {
    const updated = this._versionCheck(version, newVersion);
    const versionString = `Game: ${version.latestGamedataVersion}, Localization: ${version.latestLocalizationBundleVersion}`;
    if (updated) {
      console.log(`Received new version from update service: ${versionString}`);
      callback(version);
    } else {
      console.debug(`Received existing version from update service: ${versionString}`);
    }
  }

  _enablePolling(callback, { latestGamedataVersion, latestLocalizationBundleVersion }) {
    const self = this;
    let version = { latestGamedataVersion, latestLocalizationBundleVersion };
    this._updaterInterval = setInterval(async () => {
      try {
        const newVersion = await self.comlinkStub.getMetaData();

        self._handleVersionNotification(version, newVersion, callback);
      } catch(error) {
        self.logger.error(`Unable to fetch metadata: ${error.message}`);
      }
    }, self.updateInterval * 60 * 1000);
    //                 min  sec   msec
  }

  async listenForUpdates() {
    let updated = false;
    let version;

    try {
      version = await this._updateHook(async (receivedVersion) => {
        try {
          updated = await this.updateCheck(receivedVersion.latestGamedataVersion, receivedVersion.latestLocalizationBundleVersion);
        } catch(error) {
          console.error(`Received an updated game data version, but failed to update game data: ${error.message}`);
          // swallow update errors- do not throw
        }

        if (!updated) {
          console.log(`Received a version update, but didn't need to updated game data: ${receivedVersion}`);
        }
      });

      await this.updateCheck(version.latestGamedataVersion, version.latestLocalizationBundleVersion);
    } catch(error) {
      throw error;
    }
  }


  gameDataNeedsUpdate(versionString, force = false) {
    return force || !isStringEqual(this._version.game, versionString);
  }

  localizationNeedsUpdate(versionString, force = false) {
    return force || !isStringEqual(this._version.language, versionString);
  }

  async updateGameData(versionString) {
    try {
      let files = [];

      console.log(`Updating game data to version ${versionString}...`);

      if (this.useSegments) {
        const { GameDataSegment } = await this.clientStub.getEnums();

        const segments = Object.entries(GameDataSegment);

        for (let i = 0; i < segments.length - 1; i++) {
          const [key, val] = segments[i];

          if (!val) continue;
          const gameData = await this.comlinkStub.getGameData(versionString, INCLUDE_PVE_UNITS, val);

          for (const [key, val] of Object.entries(gameData)) {
            if (!gameData[key] || (gameData[key] && gameData[key].length === 0)) continue;
            console.log(`Found ${key} in segment ${val}`);
            await this.writeFile(key, {
              version: versionString,
              data: utils.convertToHelpFormat(val)
            });
            files.push(key);
          }
        }

      } else {
        console.log(`Fetching game data without using segments parameter`);
        const gameData = await this.comlinkStub.getGameData(versionString);

        for (const [key, val] of Object.entries(gameData)) {
          await this.writeFile(key, {
            version: versionString,
            data: utils.convertToHelpFormat(val)
          });
          files.push(key);
        }
      }

      await this.writeFile('gameDataVersion', {
        "versionString": versionString,
        "files": files
      });
      this._version.game = versionString;
      this._version.gameFiles = files;

      await this._updateCachedData();
    } catch(error) {
      throw(error);
    }
  }

  async updateLocalizationBundle(versionString) {
    if (this.noLocalization) {
      console.debug(`Skipping localization, no localization enabled`);
      return;
    }

    try {
      console.log(`Updating localization to version ${versionString}...`);
      const unzip = this.useUnzip;
      let localizationBundle = await this.comlinkStub.getLocalizationBundle(versionString, unzip);

      if (!unzip) {
        const zipped = await (new JSZip())
          .loadAsync(Buffer.from(localizationBundle.localizationBundle, 'base64'), { base64:true });
        localizationBundle = Object.entries(zipped.files);
      } else {
        localizationBundle = Object.entries(localizationBundle);
      }

      this._langMap = {};
      // iterate languages
      for (let [language, content] of localizationBundle) {
        let langMap;

        let lang = language.replace(/(Loc_)|(.txt)/gi,'');
        if (!this.languages.includes(lang)) {
          console.debug(`Skipping ${lang} localization`);
          continue;
        }

        if (!unzip) {
          const fileStream = content.nodeStream();
          langMap = await processStreamByLine(fileStream);
        } else {
          langMap = processFileContentsByLine(content);
        }

        this._langMap[lang] = langMap;

        await this.writeFile(`${lang}`, {
          version: versionString,
          data: this._langMap[lang]
        });
        this._version.language = versionString;
      }

      await this.writeFile('localizationVersion', {"versionString": versionString});
    } catch(error) {
      throw(error);
    }
  }

  async updateCheck(gameVersion, localizationVersion, force = false) {
    try {
      if (force || !gameVersion || !localizationVersion) {
        const metaData = await this.comlinkStub.getMetaData();
        gameVersion = metaData.latestGamedataVersion;
        localizationVersion = metaData.latestLocalizationBundleVersion;
      }

      if (this.gameDataNeedsUpdate(gameVersion, force) || !this._version.gameFiles ||
          (this._version.gameFiles && this._version.gameFiles.length === 0)) {
        await this.updateGameData(gameVersion);
      }

      if (this.localizationNeedsUpdate(localizationVersion, force)) {
        await this.updateLocalizationBundle(localizationVersion);
      }

      return this._version;
    } catch(error) {
      throw(error);
    }
  }

  _formatEvent({ id, nameKey, descKey, summaryKey, image, type, status, squadType, instance, ...rest }) {
    return {
      ...rest,
      id,
      nameKey,
      descKey,
      summaryKey,
      image,
      gameEventType: type,
      gameEventStatus: status,
      squadType,
      instanceList: instance ? instance.map(({
        id,
        startTime,
        endTime,
        displayStartTime,
        displayEndTime,
        timeLimited,
        campaignElementIdentifier,
        ...rest
      }) => {
        return {
          ...rest,
          id,
          startTime: Number(instance.startTime),
          endTime: Number(instance.endTime),
          displayStartTime: Number(instance.displayStartTime),
          displayEndTime: Number(instance.displayEndTime),
          timeLimited,
          campaignElementIdentifier,
        };
      }) : []
    };
  }

  async getEvents(options) {
    try {
      const gameEvent = await this.comlinkStub.getEvents();

      let response = {
        events: (gameEvent?.gameEvent) ? gameEvent.gameEvent.map(this._formatEvent) : [],
        updated: new Date().getTime()
      };

      response.events = this.project(response.events, options);
      response = this.localize(response, options);

      return response
    } catch(error) {
      throw(error);
    }
  }

  async getVersion() {
    try {
      const response = await this.comlinkStub.getMetaData();

      let gameDataVersion = response.latestGamedataVersion;
      // parse out client version
      const result = gameDataVersionRegex.exec(gameDataVersion);
      if (result && result.length === 2) {
        gameDataVersion = result[1];
      }

      await this.updateCheck(response.latestGamedataVersion, response.latestLocalizationBundleVersion);

      return {
        game: gameDataVersion,
        language: response.latestLocalizationBundleVersion
      };
    } catch(error) {
      throw(error);
    }
  }

  async execInParallel(parameter, concurrency, callback) {
    const responses = [];
    const errors = [];
    const boundCallback = (callback).bind(this);

    let execResolve;
    const execPromise = new Promise((resolve, reject) => {
      execResolve = resolve;
    });

    eachLimit(parameter, concurrency, async function(parameter) {
      try {
        responses.push(await boundCallback(parameter));
      } catch(error) {
        errors.push(error);
      }
    }, (error) => {
      execResolve(error)
    });
    const error = await execPromise;
    if (error) {
      throw(error);
    } else if (responses.length == 0 && errors.length > 0) {
      throw(errors[0]);
    }

    return responses;
  }

  async getPlayer(requestOptions = {}) {
    const options = {
      ...DEFAULT_OPTIONS,
      ...requestOptions
    };
    let response = [];
    const allyCodes = options.allyCodes || options.allycodes || options.allycode || options.allyCode;

    if (allyCodes) {
      try {
        if (Array.isArray(allyCodes)) {
          response = await this.execInParallel(allyCodes, this.concurrentPlayers, async (allyCode) => {
            return await this._getPlayer(`${allyCode}`, null, options)
          });
        } else {
          response.push(await this._getPlayer(`${allyCodes}`, null, options));
        }
      } catch(error) {
        throw(error);
      }
    } else {
      throw new Error(`No ally code specified`);
    }
    return this.localize(response, options);
  }

  localize(source, options) {
    let response = source;
    if (options.language) {
      const lang = (options.language).toUpperCase();
      if (!this._langMap[lang]) {
        throw new Error(`Unable to find language: ${options.language}`);
      }
      response = utils.localize(response, this._langMap[lang]);
    }
    return response;
  }

  project(source, options) {
    let response = source;

    if (options.project) {
      response = utils.project(response, options.project);
    }

    return response;
  }

  match(source, options) {
    let response = source;

    if (options.match) {
      response = response.filter(utils.match(options.match));
    }

    return response;
  }

  async getGuild(requestOptions = {}) {
    const options = {
      ...DEFAULT_OPTIONS,
      ...requestOptions
    };
    let response = [];
    const allyCodes = options.allyCodes || options.allycodes || options.allycode || options.allyCode;

    if (allyCodes) {
      try {
        if (Array.isArray(allyCodes)) {
          response = await this.execInParallel(allyCodes, this.concurrentGuilds, async (allyCode) => {
            return await this._getGuild(`${allyCode}`, options);
          });
        } else {
          response.push(await this._getGuild(`${allyCodes}`, options));
        }
      } catch(error) {
        throw(error);
      }
    } else {
      throw new Error(`No ally code specified`);
    }
    return this.localize(response, options);
  }

  async _getOrFetchCachedPlayer(allyCode, playerId) {
    let player;
    if (allyCode) {
      player = this._playerCache.get(allyCode);
    } else if (playerId) {
      player = this._playerCache.get(playerId);
    }

    if (!player) {
      player = await this.comlinkStub.getPlayer(allyCode, playerId);
      this._playerCache.set(player.allyCode, player);
      this._playerCache.set(player.playerId, player);
    }

    return player;
  }

  async _getPlayer(allyCode=null, playerId=null, options={}) {
    try {
      const response = await this._getOrFetchCachedPlayer(allyCode, playerId);
      return await this._formatPlayer(response, options);
    } catch(error) {
      throw(error);
    }
  }

  async _getGuild(allyCode, options = {}) {
    let guild;

    if (allyCode) {
      try {
        const player = await this._getOrFetchCachedPlayer(allyCode);
        if (!player.guildId) {
          throw new NotInGuildError(`${allyCode} is not in a guild`);
        }
        guild = await this.comlinkStub.getGuild(`${player.guildId}`, true);
      } catch(error) {
        throw(error);
      }
    }

    if (guild) {
      return await this._formatGuild(guild, options);
    } else {
      throw new Error(`No guild found`);
    }
  }

  async _formatGuild({ guild, raidLaunchConfig, ...topRest }, options) {
    const {
      profile,
      guildEventTracker,
      nextChallengesRefresh,
      recentTerritoryWarResult,
      member,
      ...guildRest
    } = guild;
    const {
      id,
      name,
      externalMessageKey,
      memberCount,
      enrollmentStatus,
      levelRequirement,
      bannerColorId,
      bannerLogoId,
      internalMessage,
      guildGalacticPower,
      ...profileRest
    } = profile;

    const raids = {};
    if (raidLaunchConfig) {
      for (const { campaignMissionIdentifier, raidId } of raidLaunchConfig) {
        raids[raidId] = campaignMissionIdentifier.campaignMissionId;
      }
    }

    let members = [];
    try {
      members = await this.execInParallel(member, this.concurrentPlayers, async ({
        playerId,
        memberLevel,
        memberContribution,
        ...rest
      }) => {
        let { name, level, allyCode, profileStat } = await this._getOrFetchCachedPlayer(null, playerId);
        let gp;
        let gpChar;
        let gpShip;
        for (const stat of profileStat) {
          if (stat.nameKey == "STAT_SHIP_GALACTIC_POWER_ACQUIRED_NAME") {
            gpShip = Number(stat.value);
          } else if (stat.nameKey == "STAT_GALACTIC_POWER_ACQUIRED_NAME") {
            gp = Number(stat.value);
          } else if (stat.nameKey == "STAT_CHARACTER_GALACTIC_POWER_ACQUIRED_NAME") {
            gpChar = Number(stat.value);
          }
          if (gp && gpChar && gpShip) break;
        }

        return {
          ...rest,
          id: utils.generatePlayerId(playerId),
          guildMemberLevel: memberLevel,
          memberContribution,
          name,
          level,
          allyCode: Number(allyCode),
          gp,
          gpChar,
          gpShip,
          updated: new Date().getTime()
        };
      });
    } catch(error) {
      throw(error);
    }

    const formattedGuild = {
      ...profileRest,
      ...topRest,
      ...guildRest,
      id: utils.generateGuildId(id),
      name,
      desc: externalMessageKey,
      members: memberCount,
      status: enrollmentStatus,
      required: levelRequirement,
      bannerColor: bannerColorId,
      bannerLogo: bannerLogoId,
      message: internalMessage,
      gp: Number(guildGalacticPower),
      raid: raids,
      roster: members,
      updated: new Date().getTime(),
      recentTerritoryWarResult,
      nextChallengesRefresh,
      guildEventTracker,
      raidLaunchConfig
    };

    return this.project(formattedGuild, options);
  }

  _formatEquipment({ equipmentId, slot, ...rest }) {
    const equipSchema = this._equipMap[equipmentId] || {};
    return {
      ...rest,
      equipmentId,
      slot,
      nameKey: equipSchema.nameKey
    };
  }

  _formatMod({ definitionId, primaryStat, id, level, tier, secondaryStat, ...rest }, flatStats) {
    const modSchema = this._modMap[definitionId] || {};
    const primaryStatId = primaryStat.stat.unitStatId;
    const primaryStatScaler = flatStats.includes(primaryStatId) ? 1e8 : 1e6;
    return {
      ...rest,
      id,
      level,
      tier,
      slot: modSchema.slot-1, // mod slots are numbered 2-7
      set: Number(modSchema.set),
      pips: modSchema.pips,
      primaryStat: {
        unitStat: primaryStat.stat.unitStatId,
        value: primaryStat.stat.unscaledDecimalValue / primaryStatScaler
      },
      secondaryStat: secondaryStat ? secondaryStat.map(stat => {
        const statId = stat.stat.unitStatId;
        const statScaler = flatStats.includes(statId) ? 1e8 : 1e6;
        return {
          unitStat: stat.stat.unitStatId,
          value: stat.stat.unscaledDecimalValue / statScaler,
          roll: stat.statRolls
        };
      }) : []
    };
  }

  _formatSkill({ id, tier, ...rest }) {
    const skillSchema = this._skillMap[id] || {};
    return {
      ...rest,
      id,
      tier: tier + 2,
      nameKey: skillSchema.nameKey,
      isZeta: skillSchema.isZeta,
      tiers: skillSchema.tiers +1
    };
  }

  async _formatPlayer({
      allyCode,
      pvpProfile,
      playerId,
      name,
      level,
      selectedPlayerTitle,
      unlockedPlayerTitle,
      guildId,
      guildName,
      guildBannerColor,
      guildBannerLogo,
      guildTypeId,
      profileStat,
      rosterUnit,
      lastActivityTime,
      localTimeZoneOffsetMinutes,
      selectedPlayerPortrait,
      unlockedPlayerPortrait,
      seasonStatus,
      ...rest
    }, options = {}) {
    let flatStats = FLAT_STATS;
    let arenaTab = 1;
    let fleetTab = 2;
    const emptyArena = { rank: null, squad: null };

    const arena = {}
    for (const { tab, rank, squad } of pvpProfile) {
      arena[tab] = {
        rank: rank,
        squad: (squad?.cell) ? squad.cell.map(({ unitId, unitDefId, squadUnitType, ...rest }) => {
          return {
            ...rest,
            id: unitId,
            defId: getUnitDefId(unitDefId),
            squadUnitType: squadUnitType
          }
        }) : []
      };
    }

    const formattedPlayer = {
      ...rest,
      allyCode: Number(allyCode),
      id: utils.generatePlayerId(playerId),
      name,
      level,
      titles: {
        selected: selectedPlayerTitle ? selectedPlayerTitle.id : null,
        unlocked: unlockedPlayerTitle ? unlockedPlayerTitle.map(title => title.id) : []
      },
      guildRefId: utils.generateGuildId(guildId),
      guildName,
      guildBannerColor,
      guildBannerLogo,
      guildTypeId,
      stats: profileStat ? profileStat.map(({ nameKey, value, index, ...rest }) => {
        return {
          ...rest,
          nameKey,
          value: Number(value),
          index
        }
      }).sort((a, b) => { return a.index - b.index }) : [],
      roster: rosterUnit ? rosterUnit.map(({
        definitionId,
        id,
        currentRarity,
        currentLevel,
        currentXp,
        currentTier,
        equipment,
        skill,
        purchasedAbilityId,
        equippedStatMod,
        unitStat,
        relic,
        ...rest
      }) => {
        const unitId = getUnitDefId(definitionId);
        const unitSchema = this._unitMap[unitId] || {crew: []};
        return {
          ...rest,
          id,
          defId: unitId,
          nameKey: unitSchema.nameKey,
          rarity: currentRarity,
          level: currentLevel,
          xp: currentXp,
          gear: currentTier,
          equipped: equipment ? equipment.map(equip => this._formatEquipment(equip)) : [],
          combatType: unitSchema.combatType,
          skills: skill ? skill.map(skill => this._formatSkill(skill)) : [],
          purchasedAbilityId,
          mods: equippedStatMod ? equippedStatMod.map(mod => this._formatMod(mod, flatStats)) : [],
          crew: unitSchema.crew ? unitSchema.crew.map(({
            unitId, slot, skillReferenceList, skilllessCrewAbilityId, ...rest
          }) => {
            return {
              ...rest,
              unitId: unitId,
              slot: slot,
              skillReferenceList: skillReferenceList,
              skilllessCrewAbilityId: skilllessCrewAbilityId,
              gp: 0, // TODO - document that it should be passed through crinolo stats
              cp: 0 // TODO - document that it should be passed through crinolo stats
            }
          }) : [],
          gp: 0, // TODO - document that it should be passed through crinolo stats
          primaryUnitStat: unitStat,
          relic
        }
      }) : [],
      arena: {
        char: arena[arenaTab] || emptyArena,
        ship: arena[fleetTab] || emptyArena
      },
      lastActivity: Number(lastActivityTime),
      poUTCOffsetMinutes: localTimeZoneOffsetMinutes,
      portraits: {
        selected: selectedPlayerPortrait ? selectedPlayerPortrait.id : null,
        unlocked: unlockedPlayerPortrait ? unlockedPlayerPortrait.map(portrait => portrait.id) : []
      },
      grandArena: seasonStatus,
      //grandArenaLifetime: already present in stats index 4
      updated: new Date().getTime()
    };

    return this.project(formattedPlayer, options);
  }

  async getGameData(requestOptions = {}) {
    const options = {
      ...DEFAULT_OPTIONS,
      ...requestOptions
    };
    let collection = options.collection;

    // remap collection to strip of the "List" suffix used by .help
    const result = gameDataListRegex.exec(collection);
    if (result && result.length === 2) {
      collection = result[1];
    }

    if (!this._version.gameFiles.includes(collection)) {
      throw new Error(`${options.collection} is not a valid game data collection`);
    }

    let response = await this.getDataFile(collection, this._version.game).catch((error) => {
      throw(error);
    });

    response = this.match(response, options);
    response = this.project(response, options);
    response = this.localize(response, options);

    return response;
  }

  async getDataFile(collection, expectedVersion, retry = false) {
    let response = {};
    let updateNeeded = false;
    try {
      response = await this.readFile(collection);
      if (expectedVersion !== response.version) {
        updateNeeded = true;
      } else {
        response = response.data;
      }
    } catch(error) {
      if (retry) {
        throw new Error(`Unable to load game data collection ${collection}`);
      } else {
        updateNeeded = true;
      }
    }

    if (updateNeeded && !retry) {
      console.warn(`There was an error reading ${collection}, attempting to update game data to resolve the error...`);
      const force = true;
      try {
        await this.updateCheck(null, null, force);
        response = await this.getDataFile(collection, expectedVersion, force);
      } catch(error) {
        throw(error);
      }
    }

    return response;
  }

  async _updateCachedData() {
    try {
      const unitList = await this.getGameData({
        collection: 'units',
        match: {
          obtainable: true,
          rarity: 7
        },
        project: {
          baseId: 1,
          combatType: 1,
          crewList: 1,
          nameKey: 1
        }
      });
      const skillList = await this.getGameData({
        collection: 'skill',
        project: {
          id: 1,
          abilityReference: 1,
          tierList: 1,
          isZeta: 1
        }
      });
      const abilityList = await this.getGameData({
        collection: 'ability',
        project: {
          id: 1,
          nameKey: 1
        }
      });
      const equipmentList = await this.getGameData({
        collection: 'equipment',
        project: {
          id: 1,
          nameKey: 1
        }
      });
      const modList = await this.getGameData({
        collection: 'statMod',
        project: {
          id: 1,
          slot: 1,
          setId: 1,
          rarity: 1
        }
      });
      const abilityMap = {};
      this._unitMap = {};
      this._equipMap = {};
      this._skillMap = {};
      this._modMap = {};

      for (const ability of abilityList) {
        abilityMap[ability.id] = ability.nameKey;
      }
      for (const unit of unitList) {
        this._unitMap[unit.baseId] = {
          nameKey: unit.nameKey,
          combatType: unit.combatType,
          crew: unit.crewList
        };
      }
      for (const equipment of equipmentList) {
        this._equipMap[equipment.id] = {
          nameKey: equipment.nameKey
        };
      }
      for (const skill of skillList) {
        this._skillMap[skill.id] = {
          nameKey: abilityMap[skill.abilityReference],
          isZeta: skill.isZeta,
          tiers: skill.tierList.length,
          abilityId: skill.abilityReference
        };
      }
      for (const mod of modList) {
        this._modMap[mod.id] = {
          pips: mod.rarity,
          set: mod.setId,
          slot: mod.slot
        };
      }

      await this.writeFile('unitMap', this._unitMap);
      await this.writeFile('equipMap', this._equipMap);
      await this.writeFile('skillMap', this._skillMap);
      await this.writeFile('modMap', this._modMap);
    } catch(error) {
      throw(error);
    }
  }

  async writeFile(fileName, jsonContents) {
    try {
      return await utils.writeFile(this.dataPath, fileName, jsonContents);
    } catch(error) {
      throw(error);
    }
  }

  async readFile(fileName) {
    try {
      return await utils.readFile(this.dataPath, fileName);
    } catch(error) {
      throw(error);
    }
  }
};
module.exports.NotInGuildError = NotInGuildError;

function getUnitDefId(unitDefId) {
  let response = unitDefId;

  try {
    response = unitDefId.split(':')[0];
  } catch(error) {
    console.warn(`Could not split unitDefId: ${unitDefId}`);
  }

  return response;
}