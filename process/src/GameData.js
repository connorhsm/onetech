"use strict";

const { spawnSync } = require('child_process');
const fs = require('fs');
const _ = require('lodash');

const GameObject = require('./GameObject');
const Category = require('./Category');
const TransitionImporter = require('./TransitionImporter');
const ChangeLog = require('./ChangeLog');
const Biome = require('./Biome');
const DepthCalculator = require('./DepthCalculator');
const SpriteProcessor = require('./SpriteProcessor');
const ObjectFilters = require('./ObjectFilters');
const ObjectBadges = require('./ObjectBadges');
const SitemapGenerator = require('./SitemapGenerator');

class GameData {
  constructor(processDir, dataDir) {
    this.processDir = processDir;
    this.dataDir = dataDir;
    const mod = process.env.ONETECH_MOD_NAME ? "-mod" : "";
    this.staticDir = processDir + `/../static${mod}`;
    this.staticDevDir = processDir + `/../static${mod}-dev`;
    this.objects = {};
    this.categories = [];
    this.biomes = [];
  }

  download(gitURL) {
    if (fs.existsSync(this.dataDir))
      spawnSync("git", ["pull"], {cwd: this.dataDir});
    else
      spawnSync("git", ["clone", gitURL, this.dataDir]);
  }

  verifyDownloaded() {
    if (!fs.existsSync(this.dataDir))
      throw "OneLifeData7 not found, first run `node process dev download`"
  }

  importObjects() {
    this.eachFileContent("objects", ".txt", (content, _filename) => {
      const object = new GameObject(content);
      if (object.id) {
        this.objects[object.id] = object;
      }
    });
    console.log("Object Count: " + Object.values(this.objects).length);
  }

  importCategories() {
    this.eachFileContent("categories", ".txt", (content, _filename) => {
      const category = new Category(content);
      category.addToObjects(this.objects);
      this.categories.push(category);
    });
    console.log("Category Count: " + this.categories.length);
  }

  importTransitions() {
    const importer = new TransitionImporter();
    this.eachFileContent("transitions", ".txt", (content, filename) => {
      importer.importFromFile(content, filename);
    });
    importer.splitCategories(this.categories);
    importer.mergeGenericTransitions();
    importer.mergeAttackTransitions();
    importer.addToObjects(this.objects);
    console.log("Transition Count: " + importer.transitions.length);
  }

  importBiomes() {
    this.eachFileInDir("ground", ".tga", (_path, filename) => {
      const biome = Biome.fromFilename(filename);
      if (biome) {
        this.biomes.push(biome);
      }
    });
    this.eachFileInDir("objects", ".txt", (path, filename) => {
      if (filename.startsWith("groundHeat")) {
        const content = fs.readFileSync(path, "utf8");
        Biome.applyGroundHeat(this.biomes, filename, content);
      }
    });
    const objects = Object.values(this.objects).filter(o => o.isNatural());
    for (let biome of this.biomes) {
      biome.addObjects(objects);
    }
    console.log("Biome Count: " + this.biomes.length);
  }

  populateVersions() {
    this.changeLog = new ChangeLog(this.dataDir, this.objects);
    this.changeLog.populateObjects();
  }

  calculateObjectDepth() {
    var calculator = new DepthCalculator();
    calculator.calculate(Object.values(this.objects));
  }

  generateTechTree() {
    var generator = new TechTreeGenerator();
    generator.generate(Object.values(this.objects));
  }

  exportObjects() {
    this.prepareStaticDir();
    this.updateTimestamp();
    this.saveJSON("objects.json", this.objectsData());
    for (let id in this.objects) {
      this.saveJSON(`objects/${id}.json`, this.objects[id].jsonData());
    }
  }

  exportVersions() {
    const versions = this.changeLog.versions.reverse();
    for (let version of versions) {
      const path = `versions/${version.id}.json`;
      if (version.id > 0 && !fs.existsSync(this.staticDevDir + "/" + path))
        this.saveJSON(path, version.jsonData());
    }
  }

  exportBiomes() {
    for (let biome of this.biomes) {
      this.saveJSON(`biomes/${biome.id}.json`, biome.jsonData());
    }
  }

  prepareStaticDir() {
    if (!fs.existsSync(this.staticDevDir) && fs.existsSync(this.staticDir))
      spawnSync("cp", ["-R", this.staticDir, this.staticDevDir]);
    this.makeDir(this.staticDevDir);
    this.makeDir(this.staticDevDir + "/sprites");
    this.makeDir(this.staticDevDir + "/ground");
    this.makeDir(this.staticDevDir + "/objects");
    this.makeDir(this.staticDevDir + "/versions");
    this.makeDir(this.staticDevDir + "/biomes");
    this.makeDir(this.staticDevDir + "/pretty-json");
    this.makeDir(this.staticDevDir + "/pretty-json/objects");
    this.makeDir(this.staticDevDir + "/pretty-json/versions");
    this.makeDir(this.staticDevDir + "/pretty-json/biomes");
  }

  makeDir(path) {
    if (!fs.existsSync(path)) fs.mkdirSync(path);
  }

  updateTimestamp() {
    const path = this.processDir + "/timestamp.txt";
    // Only update timestamp if we have changed the process script
    if (spawnSync("git", ["status", "-s", this.processDir]).stdout != "")
      fs.writeFileSync(path, new Date().getTime());
    spawnSync("cp", [path, this.staticDevDir + "/timestamp.txt"]);
  }

  saveJSON(path, data) {
    const minPath = this.staticDevDir + "/" + path;
    const prettyPath = this.staticDevDir + "/pretty-json/" + path;
    fs.writeFileSync(minPath, JSON.stringify(data));
    fs.writeFileSync(prettyPath, JSON.stringify(data, null, 2));
  }

  objectsData() {
    var objects = _.sortBy(this.objects, o => o.sortWeight()).filter(o => o.isVisible());
    return {
      ids: objects.map(o => o.id),
      names: objects.map(o => o.name),
      difficulties: objects.map(o => o.difficulty()),
      filters: ObjectFilters.jsonData(objects),
      badges: ObjectBadges.jsonData(objects),
      date: new Date(),
      versions: this.changeLog.versions.slice(1).reverse().map(v => v.id),
      biomeIds: this.biomes.map(b => b.id),
      biomeNames: this.biomes.map(b => b.name()),
      foodBonus: parseInt(process.env.ONETECH_FOOD_BONUS),
    };
  }

  convertSpriteImages() {
    const dir = this.dataDir + "/sprites";
    for (var filename of fs.readdirSync(dir)) {
      if (filename.endsWith(".tga")) {
        const id = filename.split('.')[0];
        const inPath = dir + "/" + filename;
        const outPath = this.staticDevDir + "/sprites/sprite_" + id + ".png";
        spawnSync("convert", [inPath, outPath]);
      }
    }
  }

  convertGroundImages() {
    const dir = this.dataDir + "/ground";
    for (var filename of fs.readdirSync(dir)) {
      if (filename.endsWith(".tga")) {
        const name = filename.split('.')[0];
        const inPath = dir + "/" + filename;
        const outPath = this.staticDevDir + "/ground/" + name + ".png";
        spawnSync("convert", [inPath, "-sigmoidal-contrast", "3,44%", "-level", "0%,108%,1.1", "-scale", "128x128", outPath]);
      }
    }
  }

  processSprites() {
    const processor = new SpriteProcessor(this.dataDir + "/sprites", this.staticDevDir + "/sprites")
    processor.process(this.objects)
  }

  eachFileInDir(dirName, extension, callback) {
    const dir = this.dataDir + "/" + dirName;
    for (let filename of fs.readdirSync(dir)) {
      if (filename.endsWith(extension)) {
        callback(dir + "/" + filename, filename);
      }
    }
  }

  eachFileContent(dirName, extension, callback) {
    this.eachFileInDir(dirName, extension, (path, filename) => {
      callback(fs.readFileSync(path, "utf8"), filename);
    });
  }

  syncStaticDir() {
    spawnSync("rsync", ["-aq", this.staticDevDir + "/", this.staticDir]);
  }

  generateSitemap() {
    var generator = new SitemapGenerator(this.processDir + "/../");
    generator.generate(Object.values(this.objects));
  }
}

module.exports = GameData;
