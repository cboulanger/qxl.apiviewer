const fs = require("fs");
const path = require("path");

qx.Class.define("qxl.apiviewer.RequestUtil", {
  extend: qx.core.Object,
  statics: {
    get: function (url, opts) {
      return new qx.Promise((resolve, reject) => {
        fs.readFile(url, (err, data) => {
          if (err) {
            reject(err);
          }
          resolve(data);
        });
      });
    }
  }
});

qx.Class.define("qxl.apiviewer.compile.LibraryApi", {
  extend: qx.tool.cli.api.LibraryApi,

  members: {
    async load() {
      let command = this.getCompilerApi().getCommand();
      if (command instanceof qx.tool.cli.commands.Compile) {
        command.addListener("checkEnvironment", e => this._appCompiling(e.getData().application, e.getData().environment));
      }
    },

    _appCompiling(application, environment) {
      let command = this.getCompilerApi().getCommand();
      let maker = command.getMakersForApp(application.getName())[0];
      let analyser = maker.getAnalyser();
      let target = maker.getTarget();

      return new qx.Promise(fullfiled => {
        let app = application.getName();
        let className = application.getClassName();
        if (className !== "qxl.apiviewer.Application") {
          fullfiled();
          return;
        }
        if (command.argv.verbose) {
          console.log(`start analyse for ${app}`);
        }
        let lib = analyser.findLibrary("qxl.apiviewer");
        const folder = path.join(lib.getRootDir(), lib.getSourcePath(), "qxl/apiviewer/dao");
        // preload depend classes
        require(path.join(folder, "Node.js"));
        require(path.join(folder, "ClassItem.js"));
        // load the rest
        fs.readdirSync(folder).forEach(file => {
          if (path.extname(file) === ".js") {
            require(path.join(folder, file));
          }
        });
        require(path.join(lib.getRootDir(), lib.getSourcePath(), "qxl/apiviewer/ClassLoader.js"));
        qxl.apiviewer.ClassLoader.setBaseUri(target.getOutputDir());

        let env = environment;
        let excludeFromAPIViewer = env.excludeFromAPIViewer;
        let includeToAPIViewer = env.includeToAPIViewer;
        let classInfo = analyser.getDatabase().classInfo;

        function expandClassnames(names) {
          // Expands a list of class names including wildcards (eg "qx.ui.*") into an
          // exhaustive list without wildcards
          if (!names) {
            return [];
          }
          let result = {};
          names.forEach(function (name) {
            let pos = name.indexOf('*');
            if (pos < 0) {
              result[name] = true;
            } else {
              let prefix = name.substring(0, pos);
              for (let classname in classInfo) {
                if (classname.startsWith(prefix))
                  result[classname] = true;
              }
            }
          });
          return Object.keys(result);
        }

        function getRequiredClasses() {
          let result = {};
          for (let classname in classInfo) {
            result[classname] = true;
          }
          let includes = [];
          if (includeToAPIViewer) {
            includes = expandClassnames(includeToAPIViewer);
          }
          if (excludeFromAPIViewer) {
            expandClassnames(excludeFromAPIViewer).forEach(name => {
                 if(!includes.includes(name)) {
                   delete result[name];
                 }
            });
          }
          return Object.keys(result);
        }

        function walkSync(currentDirPath, callback) {
          var fs = require('fs'),
            path = require('path');
          fs.readdirSync(currentDirPath).forEach(function (name) {
            var filePath = path.join(currentDirPath, name);
            var stat = fs.statSync(filePath);
            if (stat.isFile()) {
              callback(filePath, stat);
            } else if (stat.isDirectory()) {
              walkSync(filePath, callback);
            }
          });
        }

        env.apiviewer = {};
        env.apiviewer.classes = [];
        env.apiviewer.apiindex = {};
        env.apiviewer.apiindex.fullNames = [];
        env.apiviewer.apiindex.index = {};
        env.apiviewer.apiindex.types = ["doctree", "package", "class", "method_pub", "method_prot", "event", "property_pub", "method_priv", "method_intl", "constant", "childControl"];

        const TYPES = {
          "class": 1,
          "mixin": 1,
          "theme": 1,
          "interface": 1
        }

        function addToIndex(name, typeIdx, nameIdx) {
          if (!env.apiviewer.apiindex.index[name]) {
            env.apiviewer.apiindex.index[name] = [];
          }
          env.apiviewer.apiindex.index[name].push([typeIdx, nameIdx]);
        };

        // We sort the result so that we can get a consistent ordering for loading classes, otherwise the order in
        //  which the filing system returns the files can cause classes to be loaded in a lightly different sequence;
        //  that would not cause a problem, except that the build is not 100% repeatable.
        let classes = getRequiredClasses();
		    classes.sort();
        qx.Promise.map(classes, (classname) => {
          let cls;
          try {
            cls = qxl.apiviewer.dao.Class.getClassByName(classname, true);
          } catch (e) {
            console.error(`${e.message}`);
            return;
          }
          return cls.load().then(() => {
            if (command.argv.verbose) {
              console.log(`analyse ${cls.getName()}`);
            }
            env.apiviewer.classes.push(cls.getName());
            let nameIdx = env.apiviewer.apiindex.fullNames.indexOf(cls.getName());
            if (nameIdx < 0) {
              nameIdx = env.apiviewer.apiindex.fullNames.push(cls.getName()) - 1;
            }
            let typeIdx = TYPES[cls.getType()];
            addToIndex(cls.getName(), typeIdx, nameIdx);
            typeIdx = 1;
            addToIndex(cls.getPackageName(), typeIdx, nameIdx);
            cls.getMethods().forEach(method => {
              let typeIdx;
              if (method.isProtected())
                typeIdx = 4;
              else if (method.isPrivate())
                typeIdx = 7;
              else
                typeIdx = 3;
              addToIndex('#' + method.getName(), typeIdx, nameIdx);
            });
            cls.getProperties().forEach(prop => {
              let typeIdx = 6;
              addToIndex('#' + prop.getName(), typeIdx, nameIdx);
            });
            cls.getConstants().forEach(con => {
              let typeIdx = 9;
              addToIndex('#' + con.getName(), typeIdx, nameIdx);
            });
            cls.getEvents().forEach(evt => {
              let typeIdx = 5;
              addToIndex('#' + evt.getName(), typeIdx, nameIdx);
            });
            cls.getChildControls().forEach(ch => {
              let typeIdx = 10;
              addToIndex('#' + ch.getName(), typeIdx, nameIdx);
            });
          });
        }).then(() => {
          if (command.argv.verbose) {
            console.log(`analysing done`);
          }
          env.apiviewer.classes.sort();
          let libs = analyser.getLibraries();
          qx.Promise.map(libs, (lib) => {
            const src = path.join(lib.getRootDir(), lib.getSourcePath());
            const dest = path.join(target.getOutputDir(), "transpiled");
            walkSync(src, (file) => {
              if (path.basename(file) === "__init__.js") {
                let d = path.join(dest, path.dirname(path.relative(src, file)));
                if (fs.existsSync(d)) {
                  d = path.join(d, "package.html");
                  var meta = fs.readFileSync(file, {
                    encoding: "utf8"
                  });
                  meta = meta.replace(/^\s*\/\*/mg, "");
                  meta = meta.replace(/^\s*\*\//mg, "");
                  meta = qx.tool.compiler.jsdoc.Parser.parseComment(meta);
                  meta = meta["@description"][0].body;
                  fs.writeFileSync(d, meta, {
                    encoding: "utf8"
                  });
                }
              }
            });
          }).then(() => {
            fullfiled();
          });
        });
      });
    }
  }
});

module.exports = {
    LibraryApi: qxl.apiviewer.compile.LibraryApi
};
