function Log(lvl, ...args) {
    if (lvl <= Log.level) {
        console.error(...args);
        if (Log.cb) {
            try {
                Log.cb(...args);
            } catch (e) {
                console.error('Log cb failed:');
                console.error(e);
            }
        }
    }
}

Log.defer = (lvl, cb) => {
    if (lvl <= Log.level) {
        cb(Log.bind(null, lvl));
    }
}

Log.level = 0;
Log.error = Log.bind(null, 0);
Log.warn = Log.bind(null, 1);
Log.info = Log.bind(null, 2);
Log.log = Log.bind(null, 3);
Log.verbose = Log.bind(null, 4);
Log.annoy = Log.bind(null, 5);
Log.cb = null;

module.exports = Log;
