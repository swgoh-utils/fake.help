module.exports = class Cache {
  constructor(cacheTTL = 60000) {
    this._keyValMap = {};
    this._timeoutMap = {};
    this._cacheTTL = cacheTTL;
  }

  get(key) {
    let value;
    if (key && this._keyValMap[key]) {
      value = this._keyValMap[key];
    }
    return value;
  }

  set(key, value) {
    if (key && value) {
      this._keyValMap[key] = value;
      this.scheduleRemoval(key);
    }
  }

  scheduleRemoval(key) {
    if (this._cacheTTL > 0)  {
      this._timeoutMap[key] = setTimeout((this.remove).bind(this), this._cacheTTL, key);
    }
  }

  extendRemoval(key) {
    if (this._timeoutMap[key]) {
      clearTimeout(this._timeoutMap[key]);
    }
    this.scheduleRemoval(key);
  }

  remove(key) {
    if (key && this._keyValMap && this._keyValMap[key]) {
      delete this._keyValMap[key];

      if (this._timeoutMap[key]) {
        clearTimeout(this._timeoutMap[key]);
        delete this._timeoutMap[key];
      }
    }
  }
};