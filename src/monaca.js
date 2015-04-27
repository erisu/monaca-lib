(function() {
  'use strict';

  var Q = require('q'),
    request = require('request'),
    path = require('path'),
    fs = require('fs'),
    shell = require('shelljs'),
    crc32 = require('buffer-crc32'),
    nconf = require('nconf'),
    unzip = require('unzip'),
    rimraf = require('rimraf'),
    exec = require('child_process').exec, 
    async = require('async'),
    extend = require('extend'),
    crypto = require('crypto'),
    xml2js = require('xml2js'),
    lockfile = require('lockfile');

  // local imports
  var localProperties = require(path.join(__dirname, 'monaca', 'localProperties'));

  var USER_DATA_FILE = path.join(
    process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'],
    '.cordova', 'monaca.json'
  );

  var CONFIG_FILE = path.join(
    process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'],
    '.cordova', 'monaca_config.json'
  );

  // config
  var config = nconf.env()
    .file(path.join(__dirname, 'config.json'))
    .get('monaca');

  /**
   * @class Monaca
   * @description
   *   Create Monaca API object.
   * @param {string} [apiRoot] - Root of Monaca web API. Defaults to {@link https://ide.monaca.mobi/api}.
   * @example
   *   var monaca = new Monaca();
   *
   *   monaca.login('my@email.org', 'mypassword').then(
   *     function() {
   *       // Login successful. Let's do some stuff!
   *     },
   *     function(error) {
   *       // Login failed! :(
   *     }
   *   );
   */
  var Monaca = function(apiRoot) {
    /**
     * @description
     *   Root of Monaca web API.
     * @name Monaca#apiRoot
     * @type string
     * @default https://ide.monaca.mobi/api
     */
    Object.defineProperty(this, 'apiRoot', {
      value: apiRoot ? apiRoot : config.default_api_root,
      writable: false
    });

    /**
     * @description
     *   Version of Monaca library
     * @name Monaca#version
     * @type string
     */
    Object.defineProperty(this, 'version', {
      value: require(path.join(__dirname, '..', 'package.json')).version,
      writable: false
    });

    this._loggedIn = false;
  };
 
  Monaca.prototype._loadAllData = function() {
    var deferred = Q.defer();

    fs.exists(USER_DATA_FILE, function(exists) {
      if (exists) {
        fs.readFile(USER_DATA_FILE, function(error, data) {
          if (error) {
            deferred.reject(error);
          }
          else {
            try {
              deferred.resolve(JSON.parse(data));
            }
            catch (err) {
              deferred.reject(err);
            }
          }
        });
      }
      else {
        deferred.resolve({});
      }
    });

    return deferred.promise;
  };

  Monaca.prototype._saveAllData = function(data) {
    var deferred = Q.defer(),
      jsonData;

    try {
      jsonData = JSON.stringify(data);
    }
    catch (error) {
      return deferred.reject(error);
    }

    fs.exists(path.dirname(USER_DATA_FILE), function(exists) {
      if (!exists) {
        shell.mkdir('-p', path.dirname(USER_DATA_FILE));
      }

      fs.writeFile(USER_DATA_FILE, jsonData, function(error) {
        if (error) {
          deferred.reject(error);
        }
        else {
          deferred.resolve();
        }
      });
    });

    return deferred.promise;
  };

  Monaca.prototype.setData = function(key, value) {
    var deferred = Q.defer();

    this._loadAllData().then(
      function(data) {
        data[key] = value;

        this._saveAllData(data).then(
          function() {
            deferred.resolve(value);
          },
          function(error) {
            deferred.reject(error);
          }
        );
      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  Monaca.prototype.getData = function(key) {
    var deferred = Q.defer();

    this._loadAllData().then(
      function(data) {
        deferred.resolve(data[key]);
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  Monaca.prototype._filterFiles = function(dst, src) {
    for (var key in dst) {
      if (dst.hasOwnProperty(key)) {
        var d = dst[key];

        if (d.type == 'dir') {
          delete dst[key];
        }
        else if (dst.hasOwnProperty(key) && src.hasOwnProperty(key)) {
          var s = src[key];

          if (d.hash === s.hash) {
            delete dst[key];
          }
        }
      }
    }
  };

  Monaca.prototype._get = function(resource, data) {
    var deferred = Q.defer(),
      qs = {
        api_token: this.tokens.api
      };

    if (data) {
      extend(qs, data);
    }

    if (resource.charAt(0) !== '/') {
      resource = '/' + resource;
    }

    if (!this._loggedIn) {
      deferred.reject('Must be logged in to use this method.');
    }
    else {
      this.getConfig('http_proxy').then(
        function(httpProxy) {
          request({
            url: this.apiRoot + resource,
            qs: qs,
            encoding: null,
            proxy: httpProxy,
            headers: {
              Cookie: this.tokens.session
            }
          }, function(error, response, body) {
            if (error) {
              deferred.reject(error.code);
            } else {
              if (response.statusCode === 200) {
                deferred.resolve(body);
              } else {
                try {
                  deferred.reject(JSON.parse(body).message);
                }
                catch (e) {
                  deferred.reject(response.statusCode);
                }
              }
            }
          });
        }.bind(this),
        function(error) {
          deferred.reject(error);
        }
      )
    }

    return deferred.promise;
  };

  Monaca.prototype._post = function(resource, data) {
    var deferred = Q.defer();

    if (resource.charAt(0) !== '/') {
      resource = '/' + resource;
    }

    if (!this._loggedIn) {
      deferred.reject('Must be logged in to use this method.');
    }
    else {
      this.getConfig('http_proxy').then(
        function(httpProxy) {
          request.post({
            url: this.apiRoot + resource,
            qs: { api_token: this.tokens.api },
            headers: {
              Cookie: this.tokens.session
            },
            proxy: httpProxy,
            encoding: null,
            formData: data
          }, function(error, response, body) {
            if (error) {
              deferred.reject(error.code);
            } else {
              if (response.statusCode === 200 || response.statusCode === 201) {
                deferred.resolve(body);
              } else {
                try {
                  deferred.reject(JSON.parse(body).message);
                }
                catch (e) {
                  deferred.reject('Error code: ' + response.statusCode);
                }
              }
            }
          });
        }.bind(this),
        function(error) {
          deferred.reject(error);
        }
      );
    }
    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *  Download project file and save to disk. Must be loggeed in to
   *  use.
   * @param {string} projectId - Monaca project id.
   * @param {string} remotePath - Source file in cloud.
   * @param {string} localPath - Local file destination.
   * @return {Promise}
   * @example
   *   monaca.downloadFile('SOME_PROJECT_ID', '/remote/file', '/local/file').then(
   *     function() {
   *       // File download successful!
   *     },
   *     function(error) {
   *       // File download failed.
   *     }
   *   );
   */
  Monaca.prototype.downloadFile = function(projectId, remotePath, localPath) {
    var deferred = Q.defer();

    this._post('/project/' + projectId + '/file/read', { path: remotePath }).then(
      function(data) {
        var parentDir = path.dirname(localPath);

        fs.exists(parentDir, function(exists) {
          if (!exists) {
            shell.mkdir('-p', parentDir);
          }

          fs.writeFile(localPath, data, function(error) {
            if (error) {
              deferred.reject(error);
            }
            else {
              deferred.resolve(localPath);
            }
          });
        });
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Upload a file from disk to the cloud. Must be logged in to use.
   * @param {string} projectId - Monaca project ID.
   * @param {string} localPath - Local source file.
   * @param {string} remotePath - Remote file in cloud.
   * @return {Promise}
   * @example
   *   monaca.uploadFile('SOME_PROJECT_ID', '/local/file', '/remote/file').then(
   *     function() {
   *       // File upload successful!
   *     },
   *     function(error) {
   *       // File upload failed.
   *     }
   *   );
   */
  Monaca.prototype.uploadFile = function(projectId, localPath, remotePath) {
    var deferred = Q.defer();

    fs.exists(localPath, function(exists) {
      if (!exists) {
        deferred.reject('File does not exist.');
      }
      else {
        fs.readFile(localPath, function(error, data) {
          if (error) {
            deferred.reject(error);
          }
          else {
            this._post('/project/' + projectId + '/file/save', {
              path: remotePath,
              content: data
            }).then(
              function() {
                deferred.resolve(remotePath);
              },
              function(error) {
                deferred.reject(error);
              }
            );
          }
        }.bind(this));
      }
    }.bind(this));

    return deferred.promise;
  };

  Monaca.prototype._login = function() {
    var deferred = Q.defer();

    var form = {
        language: 'en',
      clientType: 'local',
      version: this.version
    };

    if (arguments.length === 1) {
      form.token = arguments[0];
    }
    else {
      form.email = arguments[0];
      form.password = arguments[1];
    }

    Q.all([this.getData('clientId'), this.getConfig('http_proxy')]).then(
      function(data) {
        var clientId = data[0],
          httpProxy = data[1];

        if (clientId) {
          form.clientId = clientId;
        }
        request.post({
          url: this.apiRoot + '/user/login',
          proxy: httpProxy,
          form: form
        },
        function(error, response, body) {
          var _body = JSON.parse(body || '{}');
          if (error) {
            deferred.reject(error.code);
          }
          else {
            if (response.statusCode == 200) {
              var d = Q.defer();

              this.setData('reloginToken', _body.result.token).then(
                function() {
                  this.setData('clientId', _body.result.clientId).then(
                    function() {
                      d.resolve();
                    },
                    function(error) {
                      d.reject(error);
                    }
                  );
                }.bind(this),
                function(error) {
                  d.reject(error);
                }
              );

              d.promise.then(
                function() {
                  var headers = response.caseless.dict;

                  this.tokens = {
                    api: headers['x-monaca-param-api-token'],
                    session: headers['x-monaca-param-session']
                  };                  

                  this.loginBody = _body.result;

                  this._loggedIn = true;                   
                  deferred.resolve();
                }.bind(this),
                function(error) {
                  deferred.reject(error);
                }
              );
            }
            else {
              deferred.reject(_body.message);
            }
          }
        }.bind(this));
      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );


    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Login to Monaca cloud using a saved relogin token. Use {@link Monaca#login} to
   *   login the first time.
   * @return {Promise} 
   * @example
   *   monaca.relogin().then(
   *     function() {
   *       // Login successful!
   *     },
   *     function(error) {
   *       // Login failed!
   *     }
   *   );
   */
  Monaca.prototype.relogin = function() {
    var deferred = Q.defer();

    this.getData('reloginToken').then(
      function(reloginToken) {
        this._login(reloginToken).then(
          function() {
            deferred.resolve();
          },
          function(error) {
            deferred.reject(error);
          }
        );
      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Sign in to Monaca cloud using email and password. Will save relogin token to disk 
   *   if successful. After the relogin token has been saved, {@link Monaca#relogin} can
   *   be used to login.
   * @param {string} email - A Monaca account email.
   * @param {string} password - Password associated with the account.
   * @return {Promise}
   * @example
   *   monaca.login('my@email.com', 'password').then(
   *     function() {
   *       // Login successful!
   *     },
   *     function(error) {
   *       // Login failed!
   *     }
   *   );
   */
  Monaca.prototype.login = function(email, password) {
    return this._login(email, password);
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Sign out from Monaca cloud. Will remove relogin token from disk and session tokens
   *   from memory.
   * @return {Promise}
   * @example
   *   monaca.login('my@email.com', 'password').then(
   *     function() {
   *       monaca.logout();
   *     }
   *   );
   */
  Monaca.prototype.logout = function() {
    var deferred = Q.defer();

    this.setData('reloginToken', '').then(
      function() {
        delete this.tokens;
        this._loggedIn = false;
        deferred.resolve();
      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );
    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Generate a one time token for an URL.
   * @param {string} url
   * @return {Promise}
   */
  Monaca.prototype.getSessionUrl = function(url) {
    var deferred = Q.defer();

    this._get('/user/getSessionUrl', { url: url }).then(
      function(response) {
        deferred.resolve(JSON.parse(response).result.url);
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Fetch a list of all available projects.
   * @return {Promise}
   * @example
   *   monaca.getProjects().then(
   *     function(projects) {
   *       console.log('You have ' + projects.length + ' projects!');
   *     },
   *     function(error) {
   *       // Unable to fetch list.
   *     }
   *   );
   */
  Monaca.prototype.getProjects = function() {
    var deferred = Q.defer();

    this._get('/user/projects').then(
      function(response) {
        deferred.resolve(JSON.parse(response).result.items);
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Get project ID.
   * @return {Promise}
   */
  Monaca.prototype.getProjectId = function(projectDir) {
    return localProperties.get(projectDir, 'project_id');
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Get local project ID.
   * @return {Promise}
   */
  Monaca.prototype.getLocalProjectId = function(projectDir) {
    var deferred = Q.defer(),
      absolutePath = path.resolve(projectDir);

    try {
      var projectId = crypto.createHash('sha256').update(absolutePath).digest('hex');
      deferred.resolve(projectId);
    }
    catch (error) {
      deferred.reject(error);
    }

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Set project ID.
   * @return {Promise}
   */
  Monaca.prototype.setProjectId = function(projectDir, projectId) {
    shell.mkdir('-p', path.join(projectDir, '.monaca'));
    return localProperties.set(projectDir, 'project_id', projectId);
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Fetch a list of files and directories for a project.
   *   Must be logged in to use.
   * @param {string} projectId
   * @return {Promise}
   * @example
   *   monaca.getProjectFiles('SOME_PROJECT_ID').then(
   *     function(files) {
   *       // Fetched file list!
   *     },
   *     function(error) {
   *       // Failed fetching file list!
   *     }
   *   );
   */
  Monaca.prototype.getProjectFiles = function(projectId) {
    var deferred = Q.defer();

    this._post('/project/' + projectId + '/file/tree').then(
      function(response) {
        deferred.resolve(JSON.parse(response).result.items);
      },
      function(error) {
        deferred.reject(error);
      }
    );
    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Fetch a list of files and directories for a local project.
   * @param {string} projectDir - Path to project.
   * @return {Promise}
   * @example
   *   monaca.getLocalProjectFiles = function('/some/directory').then(
   *     function(files) {
   *       // Successfully fetched file list!
   *     },
   *     function(error) {
   *       // Failed fetching file list!
   *     }
   *   );
   */
  Monaca.prototype.getLocalProjectFiles = function(projectDir) {
    var deferred = Q.defer();

    var getFileChecksum = function(file) {
      var deferred = Q.defer();

      fs.readFile(file, function(error, data) {
        if (error) {
          deferred.reject(error);
        }
        else {
          deferred.resolve(crc32(data).toString('hex'));
        }
      });

      return deferred.promise;
    };

    fs.exists(projectDir, function(exists) {
      if (exists) {
        var files = {},
          promises = [];

        var list = shell.ls('-RA', projectDir).filter(function(name) {
          return name.indexOf('node_modules') !== 0;
        });

        list.forEach(function(file) {
          var obj = {},
            key = path.join('/', file);

          // Converting Windows path delimiter to slash
          key = key.split(path.sep).join('/');
          files[key] = obj;
          
          var absolutePath = path.join(projectDir, file);

          if (fs.lstatSync(absolutePath).isDirectory()) {
            obj.type = 'dir';  
          }
          else {
            obj.type = 'file';
         
            var deferred = Q.defer();

            getFileChecksum(absolutePath).then(
              function(checksum) {
                deferred.resolve([key, checksum]);
              },
              function(error) {
                deferred.reject(error);
              }
            );

            promises.push(deferred.promise);
          }
        });

        Q.all(promises).then(
          function(results) {
            results.forEach(function(result) {
              var key = result[0],
                checksum = result[1];

              files[key].hash = checksum;
            });

            // Remove local properties file.
            delete files['/.monaca/local_properties.json'];

            deferred.resolve(files);
          },
          function(error) {
            deferred.reject(error);
          }
        );
      }
      else {
        deferred.reject(projectDir + ' does not exist');
      }
    });

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Download Monaca project and save it to disk. Must be logged in to use.
   *   Will fail if {@link destDir} already exists. The returned promise will
   *   be notified every time a file has been copied so the progress can be 
   *   tracked.
   * @param {string} projectId - Monaca project ID.
   * @param {string} destDir - Destination directory. 
   * @return {Promise}
   * @example
   *   monaca.cloneProject(123, '/home/user/workspace/myproject').then(
   *     function(dest) {
   *       console.log('Project placed in: ' + dir);
   *     },
   *     function(error) {
   *       // Wasn't able to cloneProject project! :(
   *     },
   *     function(file) {
   *       var progress = 100 * file.index / file.total;
   *       console.log('[' + progress + '%] ' + file.path); 
   *     }
   *   );
   */
  Monaca.prototype.cloneProject = function(projectId, destDir) {
    var deferred = Q.defer();
    fs.exists(destDir, function(exists) {
      if (exists && shell.ls(destDir).length > 0) {
        deferred.reject('File or directory already exists and it contains files.');
      }
      else {
        var success = true;

        try {
          shell.mkdir(destDir);
        }
        catch (e) {
          success = false;
          deferred.reject(e);
        }

        if (success) {
          this.getProjectFiles(projectId).then(
            function(files) {
              var index = 0,
                promises = [],
                defers = [];

              var totalLength = Object.keys(files)
              .map(
                function(key) {
                  return files[key].type === 'file' ? 1 : 0;
                }
              )
              .reduce(
                function(a, b) {
                  return a + b;
                }
              );

              for (var i = 0, l = totalLength; i < l; i ++) {
                var d = Q.defer();
                defers.push(d);
                promises.push(d.promise);
              }

              Object.keys(files).forEach(function(_path) {
                if (files.hasOwnProperty(_path) && files[_path].type == 'file') {
                  this.downloadFile(projectId, _path, path.join(destDir, _path)).then(
                    function(dest) {
                      deferred.notify({
                        total: totalLength,
                        index: index,
                        path: dest
                      });
                      defers[index].resolve(dest);
                    },
                    function(error) {
                      defers[index].reject(error);
                    }
                  )
                  .finally(
                    function() {
                      index++;
                    }
                  );
                }
              }.bind(this));

              Q.all(promises).then(
                function() {
                  // Save project id.
                  localProperties.set(destDir, 'project_id', projectId).then(
                    function() {
                      deferred.resolve(destDir);
                    },
                    function() {
                      deferred.reject(error);
                    }
                  );
                },
                function(error) {
                  deferred.reject(error);
                }
              );

            }.bind(this),
            function(error) {
              deferred.reject(error);
            }
          );
        }
      }
    }.bind(this));

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Create a new project in the Cloud.
   *
   *   Returns a promise that resolves to the project info.
   * @param {object} options - Parameters
   * @param {string} options.name - Project name
   * @param {string} options.description - Project description
   * @param {string} options.templateId - Template ID (e.g. "rss", "minimum", etc.)
   * @return {Promise}
   * @example
   *   monaca.createProject({
   *     name: 'My project',
   *     description: 'An awesome app that does awesome things.',
   *     template: 'minimum'
   *   }).then(
   *     function(projectId) {
   *       // Creation successful!
   *     },
   *     function(error) {
   *       // Creation failed!
   *     }
   *   );
   */
  Monaca.prototype.createProject = function(options) {
    var deferred = Q.defer();

    this._post('/user/project/create', options).then(
      function(response) {
        var data;

        try {
          data = JSON.parse(response).result;
        }
        catch (error) {
          return deferred.reject(error);
        }

        deferred.resolve(data);
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  Monaca.prototype.getProjectInfo = function(projectPath) {
    var deferred = Q.defer();

    var guessConfigFile = function(projectPath) {
      var possibleFiles = ['config.xml', 'config.ios.xml', 'config.android.xml'];

      for (var i = 0, l = possibleFiles.length; i < l; i ++) {
        var configFile = path.join(projectPath, possibleFiles[i]);

        if (fs.existsSync(configFile)) {
          return configFile;
        }
      }

      return null;
    };

    this.getLocalProjectId(projectPath).then(
      function(projectId) {
        var configFile = guessConfigFile(projectPath);
        if (configFile) {
          fs.readFile(configFile, function(error, data) {
            if (error) {
              deferred.reject(error);
            } else {
              xml2js.parseString(data, function(error, result) {
                if (error) {
                  deferred.reject(error);
                } else {
                  var project = {
                    name: result.widget.name[0],
                    directory: projectPath,
                    description: result.widget.description[0],
                    projectId: projectId
                  };

                  deferred.resolve(project);
                }
              });
            }
          });
        }
        else {
          deferred.resolve({
            name: 'Undefined Project Name',
            directory: projectPath,
            description: 'No description',
            projectId: projectId
          });
        }
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };



  /**
   * @method
   * @memberof Monaca
   * @description
   *  Uploads a Monaca project to the Cloud. Will fail if the specified
   *  directory doesn't contain a Monaca project or if the project is
   *  not associated with the logged in user. 
   *
   *  Will not overwrite files if they are identical.
   *
   *  If the upload is successful the promise will resolve with the project ID.
   * @param {string} projectDir - Project directory. 
   * @return {Promise}
   * @example
   *   monaca.uploadProject('/my/project/').then(
   *     function(projectId) {
   *       // Upload successful!
   *     },
   *     function(error) {
   *       // Upload failed!
   *     },
   *     function(progress) {
   *       // Track the progress
   *     }
   *   );
   */
  Monaca.prototype.uploadProject = function(projectDir) {
    var deferred = Q.defer();

    localProperties.get(projectDir, 'project_id').then(
      function(projectId) {
        Q.all([this.getLocalProjectFiles(projectDir), this.getProjectFiles(projectId)]).then(
          function(files) {
            var localFiles = files[0],
              remoteFiles = files[1];

            // Filter out directories and unchanged files.
            this._filterFiles(localFiles, remoteFiles);

            var fileFilter = function(fn) {
              // Exclude hidden files and folders.
              if (fn.indexOf('/.') >= 0) {
                return false;
              }

              // Only include files in /www, /merges and /plugins folders.
              return /^\/(www\/|merges\/|plugins\/|[^/]*$)/.test(fn);
            };

            var keys = Object.keys(localFiles).filter(fileFilter);

            var totalLength = keys.length,
              currentIndex = 0,
              defers = [],
              promises = [];

            for (var i = 0; i < totalLength; i++) {
              var d = Q.defer();
              defers.push(d);
              promises.push(d.promise);
            }

            keys.forEach(function(key) {
              if (localFiles.hasOwnProperty(key)) {
                var absolutePath = path.join(projectDir, key.substr(1));

                this.uploadFile(projectId, absolutePath, key).then(
                  function(remotePath) {
                    deferred.notify({
                      path: remotePath,
                      total: totalLength,
                      index: currentIndex
                    });
                    defers[currentIndex].resolve();
                  },
                  function(error) {
                    defers[currentIndex].reject(error);
                  }
                )
                .finally(
                  function() {
                    currentIndex++;
                  }
                );
              }
            }.bind(this));

            Q.all(promises).then(
              function() {
                deferred.resolve(projectId);
              },
              function(error) {
                deferred.reject(error);
              }
            );
          }.bind(this),
          function(error) {
            deferred.reject(error);
          }
        );

      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Downloads a Monaca project from the Cloud. Will fail if the 
   *   specified directory doesn't contain a Monaca project or if the
   *   project is not associated with the logged in user.
   *
   *   Will not download unchanged files.
   *
   *   If the upload is successful the promise will resolve with the
   *   project ID.
   * @param {string} projectDir - Project directory. 
   * @return {Promise}
   * @example
   *   monaca.downloadProject('/my/project/').then(
   *     function(projectId) {
   *       // Download successful!
   *     },
   *     function(error) {
   *       // Download failed!
   *     },
   *     function(progress) {
   *       // Track the progress
   *     }
   *   );
   */
  Monaca.prototype.downloadProject = function(projectDir) {
    var deferred = Q.defer();

    localProperties.get(projectDir, 'project_id').then(
      function(projectId) {
        Q.all([this.getLocalProjectFiles(projectDir), this.getProjectFiles(projectId)]).then(
          function(files) {
            var localFiles = files[0],
              remoteFiles = files[1];

            // Filter out directories and unchanged files.
            this._filterFiles(remoteFiles, localFiles);

            var totalLength = Object.keys(remoteFiles).length,
              currentIndex = 0,
              defers = [],
              promises = [];

            for (var i = 0; i < totalLength; i++) {
              var d = Q.defer();
              defers.push(d);
              promises.push(d.promise);
            }

            Object.keys(remoteFiles).forEach(function(key) {
              if (remoteFiles.hasOwnProperty(key)) {
                var absolutePath = path.join(projectDir, key.substr(1));

                this.downloadFile(projectId, key, absolutePath).then(
                  function(remotePath) {
                    deferred.notify({
                      path: remotePath,
                      total: totalLength,
                      index: currentIndex
                    });
                    defers[currentIndex].resolve();
                  },
                  function(error) {
                    defers[currentIndex].reject(error);
                  }
                )
                .finally(
                  function() {
                    currentIndex++;
                  }
                );
              }
            }.bind(this));

            Q.all(promises).then(
              function() {
                deferred.resolve(projectId);
              },
              function(error) {
                deferred.reject(error);
              }
            );
          }.bind(this),
          function(error) {
            deferred.reject(error);
          }
        );

      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Builds a Monaca project.
   *
   *   If the build is successful the promise will resolve to
   *   an object containing information about the build.
   * @param {string} projectId - Project ID.
   * @param {object} params - Build parameters.
   * @param {string} params.platform - Target platform. Should be one of "android", "ios" or "winrt".
   * @param {string} [params.android_webview] - When building for Android the webview can be configured. Choose between "default" or "crosswalk"
   * @param {string} [params.android_arch] - Required when building for Crosswalk. Should be one of either "x86" or "arm".
   * @param {string} [params.framework_version] - Framework version. Defaults to 3.5.
   * @param {string} [params.purpose] - Type of build. Should be one of either "debug" or "release". Defaults to "debug".
   * @return {Promise}
   * @example
   *   monaca.uploadProject('/some/project').then(
   *     function(projectId) {
   *       var params = {
   *         platform: 'android',
   *         purpose: 'debug'
   *       };
   *
   *       monaca.buildProject(projectId, params).then(
   *         function(result) {
   *           // Build was successful!
   *         },
   *         function(error) {
   *           // Build failed!
   *         },
   *         function(progress) {
   *           // Track build status.
   *         }
   *       );
   *     }
   *   );
   */
  Monaca.prototype.buildProject = function(projectId, params) {
    var deferred = Q.defer(),
      buildRoot = '/project/' + projectId + '/build';

    params = params || {};

    if (!params.framework_version) {
      params.framework_version = '3.5';
    }

    if (!params.purpose) {
      params.purpose = 'debug';
    }

    if (!params.platform) {
      deferred.reject('Must specify build platform.');
    }

    var pollBuild = function(queueId) {
      var deferred = Q.defer(),
        counter = 0;

      var interval = setInterval(function() {
        if (counter++ == 80) {
          clearInterval(interval);
          deferred.reject('Build timed out');
        }

        this._post(buildRoot + '/status/' + queueId).then(
          function(response) {
            var result = JSON.parse(response).result;

            deferred.notify(result.description);
            
            if (result.finished) {
              clearInterval(interval);

              if (result.status === 'finish') {
                deferred.resolve(result.description);
              }
              else {
                this._post(buildRoot + '/result/' + queueId).then(
                  function(response) {
                    deferred.reject(JSON.parse(response).result.error_message);
                  },
                  function(error) {
                    deferred.reject(error);
                  }
                );
              }
            }
          }.bind(this),
          function(error) {
            clearInterval(interval);
            deferred.reject(error);
          }
        );
      }.bind(this), 1000);

      return deferred.promise;
    }.bind(this);

    this._post(buildRoot, params).then(
      function(response) {
        var queueId = JSON.parse(response).result.queue_id;

        pollBuild(queueId).then(
          function() {
            this._post(buildRoot + '/result/' + queueId).then(
              function(response) {
                deferred.resolve(JSON.parse(response).result);
              },
              function(error) {
                deferred.reject(error);
              }
            );
          }.bind(this),
          function(error) {
            deferred.reject(error);
          },
          function(progress) {
            deferred.notify(progress);
          }
        );
      }.bind(this),
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };


  /**
   * @method
   * @memberof Monaca
   * @description
   *   Gets a list of project templates.
   *   The method will resolve to list of project templates.
   * @return {Promise}
   * @example
   *   monaca.getTemplates().then(
   *     function(templates) {
   *       //list of templates
   *     },
   *     function(err) {
   *       //error
   *     });
   */
  Monaca.prototype.getTemplates = function() {
    var deferred = Q.defer();
    try {
      var dir = path.join(__dirname, '..', 'templates'),
        list = [];
      list.push({
        name: 'Minimal Cordova Template',
        path: null
      });
      var files = fs.readdirSync(dir);
      files.forEach(function(file) {
        if (/\.zip$/.test(file)) {
          list.push({
            name: file.replace(/\.zip/g, '').replace(/_/g, ' ').replace(/(?:^|\s)\S/g, function(a) {
              return a.toUpperCase();
            }),
            path: path.join(dir, file)
          });
        }
      });
      deferred.resolve(list);
    } 
    catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;
  };

  /**
     * @method
     * @memberof Monaca
     * @description
     *   Creates a project according to the chosen template.
     *
     *   If it is successful, it will create a cordova app, replace the default templates 
     *   with the chosen ones, move the app files to working directory specified in the parameters
     *   and will install all the npm packages.
     * @param {object} options - contains all parameters
     * @param {object} options.template - template parameters 
     * @param {string} options.template.name - name of the template
     * @param {string} options.template.path - path from where the template will be taken
     * @param {string} options.appname - name with which the app will be created and an entry will be made into parmanent storage
     * @param {string} options.workingDir - where on disk the app will be created.
     * @param {string} [options.packageId] - package id for this app.
     * @return {Promise}
     * @example
     *    var template = {
     *       name: 'Onsen Tab Bar',
     *       path: '/Users/sunny/localkit/lib/templates/onsen_tab_bar.zip'
     *    };
     *    this.monaca.createApp(
     *      { template : template, 
     *        appname : 'mynewapp', 
     *        workingDir : '/Users/sunny/workspace/mynewapp'
     *      }).then(
     *      function() {
     *        //app is created
     *      },
     *      function(err) {
     *        //an error occured
     *      }
     *    );
     */
  Monaca.prototype.createApp = function(options) {
    var deferred = Q.defer(),
      template = options.template,
      appname = options.appname,
      workingDir = options.workingDir,
      packageId = options.packageId || 'io.cordova.hellocordova';

    try {
      if (appname) {
        var self = this,
          dirName = appname,
          cmd = '"' + path.join(__dirname, '..', 'node_modules', '.bin', 'cordova') + '"' + ' create  ' + '"' +  workingDir + '" ' + packageId + '  ' + appname,
          childProcess = exec(cmd);
        childProcess.on('uncaughtException', function(err) {
          deferred.reject(err);
        });
        childProcess.stdout.on('data', function(data) {
          console.log(data.toString());
        });
        childProcess.stderr.on('data', function(data) {
          process.stderr.write(data.toString());
        });
        childProcess.on('exit', function(code) {
          if (code === 0) {
            self._replaceTemplate(dirName, template, workingDir).then(
              function() {
                deferred.resolve();
              },
              function(err) {
                deferred.reject(err);
              }
            );
          } else {
            //process.exit(code);        
            deferred.reject('process exit with code ' + code);
          }
        });
      } else {
        deferred.reject('Appname needs to be specified.');
      }
    } 
    catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;
  };

  Monaca.prototype._replaceTemplate = function(dirName, template, workingDir) {
    var deferred = Q.defer();
    async.series([
      function replaceTemplate(done) {
        if (template.path) {
          var tmpPath = path.join('/tmp', 'ons' + new Date().getTime().toString());
          var wwwPath = path.join(workingDir, 'www');
          try {
            fs.createReadStream(template.path).pipe(unzip.Extract({
              path: tmpPath
            }))
            .on('close', function() {
                ['.jshintrc', 'gulpfile.js', 'package.json', 'README.md'].forEach(function(name) {                  
                  fs.renameSync(path.join(tmpPath, name), path.join(workingDir, name));
                });
                rimraf.sync(wwwPath);
                fs.renameSync(path.join(tmpPath, 'www'), wwwPath);
                rimraf.sync(tmpPath);
                done();
            })
            .on('error', function(error) {
                done(error);
            });
          } 
          catch (error) {
            done(error);
          }
        } else {
          done();
        }
      },
      function executeNpmInstall(done) {        
        if (template.path) {
          // npm install       
          var npmProcess = exec('npm install --prefix ' + '"' + workingDir + '"');
          npmProcess.stdout.on('data', function(data) {
            console.log(data);
          });
          npmProcess.stderr.on('data', function(data) {
            console.log(data);
          });
          npmProcess.on('exit', function(code) {
            if (code === 0) {
              console.log('Set template: ' + template.name);
              done();
            } else {
              done(code);
            }
          });
        } else {
          done();
        }
      }
    ],
    function(err, results) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve();
      }
    });
    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Set config file path.
   * @param {String} configFile
   * @return {Promise}
   */
  Monaca.prototype.setConfigFile = function(configFile) {
    var deferred = Q.defer();

    // Parent directory must exist.
    var parentDir = path.dirname(configFile);
    fs.exists(parentDir, function(exists) {
      if (exists) {
        this._configFile = configFile;
        deferred.resolve(configFile);
      }
      else {
        deferred.reject('Unable to set config file: ' + parentDir + ' does not exist.');
      }
    }.bind(this));

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Get current config file.
   * @return {Promise}
   */
  Monaca.prototype.getConfigFile = function() {
    var deferred = Q.defer();

    deferred.resolve(this._configFile || CONFIG_FILE);

    return deferred.promise;
  };

  Monaca.prototype._ensureConfigFile = function() {
    var deferred = Q.defer();

    // Ensure that config file exists.
    this.getConfigFile().then(
      function(configFile) {
        var parentDir = path.dirname(configFile);

        fs.exists(parentDir, function(exists) {
          if (!exists) {
            try {
              shell.mkdir('-p', path.dirname(parentDir));
            }
            catch (err) {
              return deferred.reject(err);
            }
          }

          fs.exists(configFile, function(exists) {
            if (!exists) {
              fs.writeFile(configFile, '{}', function(err) {
                if (err) {
                  deferred.reject(err);
                }
                else {
                  deferred.resolve(configFile);
                }
              });
            }
            else {
              deferred.resolve(configFile);
            }
          });
        });
      },
      function() {
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Set a config value.
   * @param {String} key
   * @param {String} value
   * @return {Promise}
   * @example
   *   monaca.setConfig('http_proxy_host', '1.2.3.4').then(
   *     function(value) {
   *       console.log('Proxy host set to ' + value);
   *     },
   *     function(error) {
   *       console.log('An error has occurred: ' + error);
   *     }
   *   );
   */
  Monaca.prototype.setConfig = function(key, value) {
    if (typeof key === 'undefined') {
      throw new Error('"key" must exist.');
    }
    else if (typeof key !== 'string') {
      throw new Error('"key" must be a string.');
    }
    else if (typeof value === 'undefined') {
      throw new Error('"value" must exist.');
    }
    else if (typeof value !== 'string') {
      throw new Error('"value" must be a string.');
    }

    var deferred = Q.defer();

    this._ensureConfigFile().then(
      function(configFile) {
        var lockFile = configFile + '.lock';

        lockfile.lock(lockFile, {wait: 10000}, function(error) {
          if (error) {
            return deferred.reject(error);
          }

          var unlock = function() {
            lockfile.unlock(lockFile, function(error) {
              if (error) {
                console.error(error);
              }
            });
          };

          fs.readFile(configFile, function(error, data) {
            if (error) {
              unlock();
              return deferred.reject(error);
            }

            try {
              var ob = JSON.parse(data);
              ob[key] = value;

              fs.writeFile(configFile, JSON.stringify(ob), function(error) {
                unlock();

                if (error) {
                  deferred.reject(error);
                }
                else {
                  deferred.resolve(value);
                }
              });
            }
            catch (err) {
              unlock();
              deferred.reject(err);
            }
          });
        });
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Remove a config value.
   * @param {String} key
   * @return {Promise}
   */
  Monaca.prototype.removeConfig = function(key) {
    if (typeof key === 'undefined') {
      throw new Error('"key" must exist.');
    }
    else if (typeof key !== 'string') {
      throw new Error('"key" must be a string.');
    }

    var deferred = Q.defer();

    this._ensureConfigFile().then(
      function(configFile) {
        var lockFile = configFile + '.lock';

        lockfile.lock(lockFile, {wait: 10000}, function(error) {
          if (error) {
            return deferred.reject(error);
          }

          var unlock = function() {
            lockfile.unlock(lockFile, function(error) {
              if (error) {
                console.error(error);
              }
            });
          };

          fs.readFile(configFile, function(error, data) {
            if (error) {
              unlock();
              return deferred.reject(error);
            }

            try {
              var ob = JSON.parse(data),
                value = ob[key];

              delete ob[key];

              fs.writeFile(configFile, JSON.stringify(ob), function(error) {
                unlock();

                if (error) {
                  deferred.reject(error);
                }
                else {
                  deferred.resolve(value);
                }
              });
            }
            catch (err) {
              unlock();
              deferred.reject(err);
            }
          });
        });
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Get a config value.
   * @param {String} key
   * @return {Promise}
   * @example
   *   monaca.getConfig('http_proxy_host').then(
   *     function(value) {
   *       console.log('Proxy host is ' + value);
   *     },
   *     function(error) {
   *       console.log('Unable to get proxy host: ' + error);
   *     }
   *   );
   */
  Monaca.prototype.getConfig = function(key) {
    if (typeof key === 'undefined') {
      throw new Error('"key" must exist.');
    }
    else if (typeof key !== 'string') {
      throw new Error('"key" must be a string.');
    }

    var deferred = Q.defer();

    this.getAllConfigs().then(
      function(settings) {
        deferred.resolve(settings[key]); 
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  /**
   * @method
   * @memberof Monaca
   * @description
   *   Get all config key-value pairs.
   * @param {String}
   * @return {Promise}
   * @example
   *   monaca.getAllConfigs().then(
   *     function(settings) {
   *     },
   *     function(error) {
   *       console.log('Unable to get configs: ' + error);
   *     }
   *   );
   */
  Monaca.prototype.getAllConfigs = function() {
    var deferred = Q.defer();

    this._ensureConfigFile().then(
      function(configFile) {
        fs.readFile(configFile, function(error, data) {
          if (error) {
            deferred.reject(error);
          }
          else {
            try {
              deferred.resolve(JSON.parse(data));
            }
            catch (err) {
              deferred.reject(err);
            }
          }
        });
      },
      function(error) {
        deferred.reject(error);
      }
    );

    return deferred.promise;
  };

  module.exports = Monaca;
})();