const fs = require('fs');
const path = require('path');

// https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
// https://gist.github.com/tnhu/d293b0382b5a2c4a561b
function createHash(str) {
  let hval = 0x811c9dc5;
  // Strips unicode bits, only the lower 8 bits of the values are used
  for (let i = 0; i < str.length; i++) {
    hval = hval ^ (str.charCodeAt(i) & 0xFF);
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
  }

  return (hval >>> 0).toString();
}

module.exports.generateGuildId = function(guildId) {
  if( !guildId || guildId.length === 0 ) { return ''; }
  return 'G'+createHash(guildId);
};

module.exports.generatePlayerId = function(playerId) {
  if( !playerId || playerId.length === 0 ) { return ''; }
  return 'P'+createHash(playerId);
};

function isTruthyObject(value) {
  return (typeof value === 'object' && value !== null);
}

function isTruthyWithZero(value) {
  return value || value == 0;
}

// special case casting scenarios to match .help behavior
const NUMBER_KEYS = [
  "galacticScoreRequirement",
  "obtainableTime",
  "raidDuration",
  "scalar",
  "statValueDecimal",
  "uiDisplayOverrideValue",
  "unscaledDecimalValue"
];

const replacerFunc = (key, value) => {
  if (!value) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    const replacement = {};
    for (const k in value) {
      let newK = k;
      if (value[k] && Array.isArray(value[k])) {
        newK = `${k}List`;
      }
      replacement[newK] = value[k];
    }
    return replacement;
  } else if (NUMBER_KEYS.includes(key)) { // cast some values to number
    return Number(value);
  }
  return value;
};

module.exports.convertToHelpFormat = convertToHelpFormat;
function convertToHelpFormat(inputJson) {
  return JSON.parse(JSON.stringify(inputJson, replacerFunc));
}

module.exports.localize = localize;
function localize(source, language) {
  let response = {};
  if (source && language) {
    if (Array.isArray(source)) {
      response = [];
      for (let i = 0; i < source.length; i++) {
        response.push(localize(source[i], language));
      }
    } else {
      if (isTruthyObject(source)) {
        for (let key of Object.keys(source)) {
          const sourceValue = source[key];

          if (isTruthyObject(sourceValue)) {
            response[key] = localize(sourceValue, language);
          } else {
            if (isTruthyWithZero(sourceValue) && language[sourceValue]) {
              response[key] = language[sourceValue];
            } else {
              response[key] = sourceValue;
            }
          }
        }
      } else {
        if (isTruthyWithZero(source) && language[source]) {
          response = language[source];
        } else {
          response = source;
        }
      }
    }
  } else {
    response = source;
  }

  return response;
};

module.exports.match = function(matchFilter) {
  // expecting to be used with Array.prototype.filter, so return a filter function
  return (value) => {
    let matches = true;
    for (let matchKey of Object.keys(matchFilter)) {
      if (matchFilter[matchKey] != value[matchKey]) {
        // short circuit out
        matches = false;
        break;
      }
    }
    return matches;
  };
};

module.exports.project = project;
function project(source, projection) {
  let response = {};
  if (source && projection) {
    if (Array.isArray(source)) {
      response = [];
      // assume this is a top level source, nested array projections not really supported
      for (let i = 0; i < source.length; i++) {
        response.push(project(source[i], projection));
      }
    } else {
      const keys = Object.keys(projection);
      if (keys.length > 0) {
        for (let projectKey of keys) {
          const sourceValue = source[projectKey];
          const projectValue = projection[projectKey];

          // handle nested projections
          if (isTruthyObject(sourceValue) && isTruthyObject(projectValue)) {
            response[projectKey] = project(sourceValue, projectValue);
          } else {
            if (projectValue && isTruthyWithZero(sourceValue)) {
              response[projectKey] = sourceValue;
            }
          }
        }
      } else {
        return source;
      }
    }
  } else {
    response = source;
  }

  return response;
};

module.exports.structurify = function(json) {
  return JSON.parse(JSON.stringify(json, structurifyReplacer));
};

function structurifyReplacer(key, value) {
  if (Array.isArray(value)) {
    return [value[0]];
  } else {
    if (typeof value !== 'object') {
      return typeof value;
    }
    return value;
  }
}

module.exports.writeFile = async function (dataPath, fileName, jsonContents) {
  try {
    return await fs.promises.writeFile(path.join(dataPath, `${fileName}.json`), JSON.stringify(jsonContents), {encoding: "utf8"});
  } catch(error) {
    throw(error);
  }
}

module.exports.readFile = async function (dataPath, fileName) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dataPath, `${fileName}.json`), {encoding: "utf8"}));
  } catch(error) {
    throw(error);
  }
}