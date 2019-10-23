function Log(lvl, ...args)
{
    if (lvl <= Log.level)
        console.error(...args);
}

Log.defer = (lvl, cb) => {
    if (lvl <= Log.level) {
        cb(console.error.bind(console));
    }
}

Log.level = 0;
Log.error = Log.bind(null, 0);
Log.warn = Log.bind(null, 1);
Log.info = Log.bind(null, 2);
Log.log = Log.bind(null, 3);
Log.verbose = Log.bind(null, 4);
Log.annoy = Log.bind(null, 5);

module.exports = Log;
