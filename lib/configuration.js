var websocket = require('websocket-stream'),
    http2 = require('http2'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    InvalidStateError = require('./errors.js').InvalidStateError,
    RequestInfo = require('./cache.js').RequestInfo,
    Cache = require('./cache.js').Cache,
    Agent = require('./agent').Agent,
    logger = require('./logger'),
    parseUrl = require('url').parse,
    getOrigin = require('./utils.js').getOrigin,
    CacheListener = require('./cache-listener').CacheListener;

//////////////////////////////////////////// Configuration ////////////////////////////////////////////
function Configuration(options) {
    var self = this;
    options = options || {};

    EventEmitter.call(this);
    
    self._activeConfigurationCnt = 0;
    self._proxyMap = {};
    self._activeTransportConnections = {};
            
    // Init debug/log
    self.debug = options.debug;
    self._log = options.log || (self.debug ? logger.consoleLogger : logger.defaultLogger);
    
    // Init Cache
    self.cache = options.cache || new Cache({
        debug: self.debug,
        log: self._log
    });
    self.cacheListener = new CacheListener(self);

    self.agent = new Agent({
        log: self._log
    });
}

util.inherits(Configuration, EventEmitter);

var confProto = Configuration.prototype;

confProto.configuring = function () {
    this._activeConfigurationCnt++;
};

confProto.configured = function () {
    this._activeConfigurationCnt--;
    if (this._activeConfigurationCnt === 0) {
        this.emit('completed');
    }
};

confProto.isConfiguring = function () {
    return this._activeConfigurationCnt > 0;
};

confProto.getTransport = function (url) {
    if (!this._activeTransportConnections[url] || !this._activeTransportConnections[url].writable) {
        if (this.debug) {
            this._log.info("Opening transport: " + url);
        }
        var parsedUrl = parseUrl(url);
        if(parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:'){
            // TODO, maybe enable perMessageDeflate in production or on debug??
            this._activeTransportConnections[url] = websocket(url, "h2", {perMessageDeflate: false});
        }else if(parsedUrl.protocol === 'tcp:'){
            this._activeTransportConnections[url] = require('net').connect({
                'host' : parsedUrl.hostname,
                'port' : parsedUrl.port
            });
        }else{
            throw new Error('Unrecognized transport protocol: ' + parsedUrl.protocol + ', for transport: ' + url);
        }
    }
    return this._activeTransportConnections[url];
};

confProto.getTransportUrl = function (origin) {
    return this._proxyMap[origin];
};

confProto.onPush = function (pushRequest, origin) {
    var self = this;
    pushRequest.href = origin + pushRequest.url;
    if (self.debug) {
        this._log.info("Received push promise for: " + pushRequest.href);
    }

    pushRequest.on('response', function (response) {

        response.on('data', function (data) {
            if (response.data) {
                response.data += data;
            } else {
                response.data = data;
            }
        });

        var requestInfo = origin ? new RequestInfo(pushRequest.method, origin + pushRequest.url, pushRequest.headers) :
            new RequestInfo(pushRequest.method, getOrigin(pushRequest) + pushRequest.url, pushRequest.headers);
        response.on('end', function () {
            self.cache.put(requestInfo, response).catch(function () {
                // NOOP
            });
        });

        response.on('error', function (e) {
            this._log.warn("Server push stream error: " + e);
        });
    });

    // TODO consider closing if already cached, (NOTE RACE CONDITION IF register callbacks on response here, cause
    // might already fire events prior to cache promis returning
    // this.cache.match(pushRequest).then(function (response) {
    //     if (response) {
    //         this._log.warn("Server pushed an already cached result or an un cache-able request: " + response);
    //         pushRequest.close();
    //     }
    // });
};

// open h2 pull channel
confProto.openH2StreamForPush = function (hostname, port, proxyTransportPath, proxyTransportUrl, origin) {
    if (this.debug) {
        var pushChannel = hostname + ':' + port + proxyTransportPath;
        this._log.info('Opening h2 channel for pushing: ' + pushChannel);
    }
    var self = this,
        transport = this.getTransport(proxyTransportUrl),
        transportUrl = parseUrl(proxyTransportUrl);

    var request = http2.raw.request({
        agent: self.agent,
        hostname: transportUrl.hostname,
        port: transportUrl.port,
        path: proxyTransportPath,
        transportUrl: proxyTransportUrl,
        transport: transport,
    }, function (response) {
        if(self.debug){
            this._log.info("push channel opened: " + pushChannel);
        }
        var reopen = function () {
            this._log.warn('h2 pull stream closed, perhaps we should reopen: ' + hostname + ' ' + port + ' ' + proxyTransportPath);
            // TODO progressive back off??
            // probably on request.on('error');
            this.openH2StreamForPush(hostname, port, proxyTransportPath, proxyTransportUrl, origin);
        };
        response.on('finish', reopen);
        response.on('error', reopen);
        response.on('open', reopen);
    });

    // add to cache when receive pushRequest
    request.on('push', function (pushRequest) {
        self.onPush(pushRequest, origin, this.cache);
    });
    request.end();
};

// parse config json
confProto.parseConfig = function (config) {
    try {
        config = typeof config === 'string' ? JSON.parse(config) : config;
    } catch (JsonErr) {
        throw new Error('Unable to parse config: ' + config);
    }
    return config;
};

// add config by json
confProto.addConfig = function (config) {
        
    // Decode config
    config = this.parseConfig(config);

    var proxyUrl = config.url;
    var proxyTransportUrl = config.options.transport;
    var proxyH2PushPath = config.options.h2PushPath;
    this.debug = this.debug || config.options.debug;
    this.cache.setDebug(this.debug);

    proxyUrl = parseUrl(proxyUrl);
    var origin = getOrigin(proxyUrl);

    this._proxyMap[origin] = proxyTransportUrl;

    if (proxyH2PushPath) {
        this.openH2StreamForPush(proxyUrl.hostname, proxyUrl.port, proxyH2PushPath, proxyTransportUrl, origin);
    }
};

// add config by url
confProto.fetchConfig = function (url) {
    var xhr = new XMLHttpRequest();
    // TODO, consider using semi-public API??
    xhr._open('GET', url);
    this.configuring();
    var self = this;
    xhr.addEventListener("load", function () {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            var status = xhr.status;
            if (status !== 200) {
                throw new InvalidStateError('Failed to load configuration ' + url + ', status code: ' + status);
            }
            self.addConfig(xhr.response);
            self.configured();
        }
    }, true);
    // TODO, consider using semi-public API??
    xhr._send();
};

// add configs by an array of urls
confProto.configure = function (urls) {
    if (urls instanceof Array) {
        var cntI = urls.length;
        for (var i = 0; i < cntI; i++) {
            if (typeof urls[i] === 'string') {
                this.fetchConfig(urls[i]);
            } else if (typeof urls[i] === 'object') {
                this.configuring();
                this.addConfig(urls[i]);
                this.configured();
            } else {
                throw new SyntaxError('Invalid arg: ' + urls);
            }
        }
    } else {
        throw new SyntaxError('Invalid arg: ' + urls);
    }
};

module.exports = Configuration;
