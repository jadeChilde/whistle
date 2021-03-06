var fs  = require('fs');
var fse = require('fs-extra');
var path = require('path');
var logger = require('../util/logger');
var ENCODING = {encoding: 'utf8'};
var RETRY_INTERVAL = 16000;

function readFileSafe(file) {
  try {
    file = fs.readFileSync(file, ENCODING);
  } catch(e) {
    file = null;
    logger.error(e);
  }

  return file || '';
}

function readJsonSafe(file) {
  try {
    file = fs.readFileSync(file, ENCODING);
    file = file && JSON.parse(file);
  } catch(e) {
    file = null;
    logger.error(e);
  }

  return file || {};
}

function copyFileObj(file) {
  if (!file) {
    return file;
  }

  return {
    index: file.index,
    name: file.name,
    data: file.data,
    selected: file.selected
  };
}

function noop() {}

function Storage(dir) {
  var self = this;
  if (!(self instanceof Storage)) {
    return new Storage(dir);
  }

  fse.ensureDirSync(dir);

  self._files = path.join(dir, 'files');
  self._properties = path.join(dir, 'properties');
  fse.ensureDirSync(self._files);
  fse.ensureFileSync(self._properties);

  var maxIndex = -1;
  var files = {};
  fs.readdirSync(self._files).forEach(function(file) {
    if (!/^(\d+)\.(.+)$/.test(file)) {
      return;
    }
    try {
      var index = parseInt(RegExp.$1, 10);
      var filename = decodeURIComponent(RegExp.$2);
      if (index > maxIndex) {
        maxIndex = index;
      }
      files[filename] = {
        index: index,
        name: filename,
        data: readFileSafe(path.join(self._files, file))
      };
    } catch(e) {
      logger.error(e);
    }
  });

  var properties = readJsonSafe(self._properties);
  self._cache = {
    maxIndex: maxIndex,
    files: files,
    properties: properties
  };

  var filesOrder = properties.filesOrder;
  if (!Array.isArray(filesOrder)) {
    filesOrder = null;
  }
  filesOrder = Object.keys(files).sort(function(cur, next) {
    if (filesOrder) {
      var curIndex = filesOrder.indexOf(cur);
      if (curIndex !== -1) {
        var nextIndex = filesOrder.indexOf(next);
        if (nextIndex !== -1) {
          return curIndex > nextIndex ? 1 : -1;
        }
      }
    }
    cur = files[cur];
    next = files[next];
    return cur.index > next.index ? 1 : -1;
  });
  self.setProperty('filesOrder', filesOrder);
}

var proto = Storage.prototype;

proto._writeProperties = function _writeProperties() {
  var self = this;
  if (self._writePropertiesPending) {
    self._writePropertiesWaiting = true;
    return;
  }
  clearTimeout(self._writePropertiesTimeout);
  self._writePropertiesPending = true;
  fse.outputJson(self._properties, self._cache.properties, function(err) {
    self._writePropertiesPending = false;
    if (self._writePropertiesWaiting) {
      self._writePropertiesWaiting = false;
      self._writeProperties();
    } else if (err) {
      self._writePropertiesTimeout = setTimeout(self._writeProperties.bind(self), RETRY_INTERVAL);
      logger.error(err);
    }
  });
};

proto._writeFile = function _writeFile(file) {
  var self = this;
  if (!(file = self._cache.files[file])) {
    return;
  }
  if (file._pending) {
    file._waiting = true;
    return;
  }
  clearTimeout(file._timeout);
  file._pending = true;
  fs.writeFile(self._getFilePath(file), file.data, function(err) {
    file._pending = false;
    if (file._waiting) {
      file._waiting = false;
      self._writeFile(file.name);
    } else if (err) {
      file._timeout = setTimeout(function() {
        self._writeFile(file.name);
      }, RETRY_INTERVAL);
      logger.error(err);
    }
  });
};

proto._getFilePath = function _getFilePath(file) {
  file = typeof file == 'string' ? this._cache.files[file] : file;
  var name = file.name;
  try {
    name = encodeURIComponent(file.name);
  } catch(e) {
    logger.error(e);
  }
  return file && path.join(this._files, file.index + '.' + name);
};

proto.count = function count() {
  return Object.keys(this._cache.files).length;
};

proto.existsFile = function existsFile(file) {
  return this._cache.files[file];
};

proto.getFileList = function getFileList(origObj) {
  var cache = this._cache;
  var files = cache.files;
  var filesOrder = cache.properties.filesOrder;
  return filesOrder.map(function(file) {
    return origObj ? files[file] : copyFileObj(files[file]);
  });
};

proto.writeFile = function writeFile(file, data) {
  if (!file) {
    return;
  }

  var self = this;
  var cache = self._cache;
  var fileData = cache.files[file];
  if (!fileData) {
    fileData = cache.files[file] = {
      index: ++cache.maxIndex,
      name: file
    };
    cache.properties.filesOrder.push(file);
    self._writeProperties();
  }
  fileData.data = data == null ? '' : data;
  self._writeFile(file);
  return fileData;
};

proto.updateFile = function updateFile(file, data) {
  return this.existsFile(file) && this.writeFile(file, data);
};

proto.readFile = function(file) {
  file = file && this._cache.files[file];
  return file && file.data;
};

proto.removeFile = function removeFile(file) {
  var files = this._cache.files;
  file = file && files[file];
  if (!file) {
    return;
  }
  var filesOrder = this._cache.properties.filesOrder;
  filesOrder.splice(filesOrder.indexOf(file.name), 1);
  delete files[file.name];
  fs.unlink(this._getFilePath(file), noop);
  this._writeProperties();
  return true;
};

proto.renameFile = function renameFile(file, newFile) {
  var cache = this._cache;
  if (!newFile || !(file = cache.files[file])
|| cache.files[newFile]) {
    return;
  }
  var filesOrder = this._cache.properties.filesOrder;
  filesOrder[filesOrder.indexOf(file.name)] = newFile;
  var path = this._getFilePath(file);
  delete cache.files[file.name];
  file.name = newFile;
  cache.files[newFile] = file;
  fs.rename(path, this._getFilePath(file), noop); //不考虑并发
  this._writeProperties();
  return true;
};

proto.moveTo = function(fromName, toName) {
  var filesOrder = this._cache.properties.filesOrder;
  var fromIndex = filesOrder.indexOf(fromName);
  if (fromIndex === -1) {
    return false;
  }
  var toIndex = filesOrder.indexOf(toName);
  if (toIndex === -1) {
    return false;
  }
  filesOrder.splice(fromIndex, 1);
  filesOrder.splice(toIndex, 0, fromName);
  this._writeProperties();
  return true;
};

proto.setProperty = function setProperty(name, value) {
  this._cache.properties[name] = value;
  this._writeProperties();
};

proto.hasProperty = function hasProperty(name) {
  return name in this._cache.properties;
};

proto.setProperties = function setProperties(obj) {
  if (!obj) {
    return;
  }

  var props = this._cache.properties;
  Object.keys(obj).forEach(function(key) {
    props[key] = obj[key];
  });
  this._writeProperties();
  return true;
};

proto.getProperty = function getProperty(name) {
  return this._cache.properties[name];
};

proto.removeProperty = function removeProperty(name) {
  if (this.hasProperty(name) && name !== 'filesOrder') {
    delete this._cache.properties[name];
    this._writeProperties();
  }
};

module.exports = Storage;
