
module.exports = function (RED) {
    "use strict";
    const got = require("got");
    const { CookieJar } = require("tough-cookie");
    const FormData = require('form-data');
    var querystring = require("querystring");
    var cookie = require("cookie");
    var hashSum = require("hash-sum");

    const HTTPS_MODULE = require("https");
    const HTTPS_REQUEST = HTTPS_MODULE.request;

    function checkNodeAgentPatch() {
        if (HTTPS_MODULE.request !== HTTPS_REQUEST && HTTPS_MODULE.request.length === 2) {
            RED.log.warn(`

---------------------------------------------------------------------
Patched https.request function detected. This will break the
HTTP Request node. The original code has now been restored.

This is likely caused by a contrib node including an old version of
the 'agent-base@<5.0.0' module.

You can identify what node is at fault by running:
   npm list agent-base
in your Node-RED user directory (${RED.settings.userDir}).
---------------------------------------------------------------------
`);
            HTTPS_MODULE.request = HTTPS_REQUEST
        }
    }

    function VideoInputNode(config) {
        RED.nodes.createNode(this, config);
        checkNodeAgentPatch();
        var node = this;
        var nodeUrl = 'http://127.0.0.1:5550';
        var deviceType = config.deviceType;
        var rtsp = config.rtsp || '';
        var resolution = config.resolution;
        var local = config.local;
        
        var nodeMethod = "GET";
        var redirectList = [];

        this.interval_id = null;
        var sendErrorsToCatch = config.senderr;

        var nodeHTTPPersistent = true;

        if (RED.settings.httpRequestTimeout) { this.reqTimeout = parseInt(RED.settings.httpRequestTimeout) || 120000; }
        else { this.reqTimeout = 120000; }

        let timingLog = false;
        if (RED.settings.hasOwnProperty("httpRequestTimingLog")) {
            timingLog = RED.settings.httpRequestTimingLog;
        }
        
        let fps = config.frequency || 10;
        fps = parseInt(fps)
        fps = fps <= 0 ? 10 : fps;

        let requestInterval = 1000 / fps;
        checkNodeAgentPatch();

        //reset redirectList on each request
        redirectList = [];
        if (config.active) {
            this.interval_id = startInterval()
        }

        this.on("input", function (msg, nodeSend, nodeDone) {
            if (msg.action) {
                if (this.interval_id == null) {
                    this.interval_id = startInterval()
                }
            } else {
                if (this.interval_id != null) {
                    clearInterval(this.interval_id);
                    this.interval_id = null;
                }
            }

        });
        this.on("close", function () {
            if (this.interval_id != null) {
                clearInterval(this.interval_id);
            }
            node.status({});
        });

        function emitTimingMetricLog(timings, msg) {
            const props = [
                "start",
                "socket",
                "lookup",
                "connect",
                "secureConnect",
                "upload",
                "response",
                "end",
                "error",
                "abort"
            ];
            if (timings) {
                props.forEach(p => {
                    if (timings[p]) {
                        node.metric(`timings.${p}`, msg, timings[p]);
                    }
                });
            }
        }

        function extractCookies(setCookie) {
            var cookies = {};
            setCookie.forEach(function (c) {
                var parsedCookie = cookie.parse(c);
                var eq_idx = c.indexOf('=');
                var key = c.substr(0, eq_idx).trim()
                parsedCookie.value = parsedCookie[key];
                delete parsedCookie[key];
                cookies[key] = parsedCookie;
            });
            return cookies;
        }

        function startInterval() {
            var interval_id = setInterval(() => {
                let msg = {}
                var preRequestTimestamp = process.hrtime();
                node.status({ fill: "blue", shape: "dot", text: "sampling" });
                var url
                if (deviceType=='rtsp') {
                    url = nodeUrl+`?resolution=${resolution}&rtspUrl=${encodeURIComponent(rtsp)}`;
                }else {//local
                    url = nodeUrl+`?resolution=${resolution}&localAddress=/dev/${local}`;
                }

                if (!url) {
                    node.error(RED._("No url specified"), msg);
                    // nodeDone();
                    return;
                }

                // url must start http:// or https:// so assume http:// if not set
                if (url.indexOf("://") !== -1 && url.indexOf("http") !== 0) {
                    node.warn(RED._("non-http transport requested"));
                    node.status({ fill: "red", shape: "ring", text: "non-http transport requested" });
                    // nodeDone();
                    return;
                }

                // The Request module used in Node-RED 1.x was tolerant of query strings that
                // were partially encoded. For example - "?a=hello%20there&b=20%"
                // The GOT module doesn't like that.
                // The following is an attempt to normalise the url to ensure it is properly
                // encoded. We cannot just encode it directly as we don't want any valid
                // encoded entity to end up doubly encoded.
                if (url.indexOf("?") > -1) {
                    // Only do this if there is a query string to deal with
                    const [hostPath, ...queryString] = url.split("?")
                    const query = queryString.join("?");
                    if (query) {
                        // Look for any instance of % not followed by two hex chars.
                        // Replace any we find with %25.
                        const escapedQueryString = query.replace(/(%.?.?)/g, function (v) {
                            if (/^%[a-f0-9]{2}/i.test(v)) {
                                return v;
                            }
                            return v.replace(/%/, "%25")
                        })
                        url = hostPath + "?" + escapedQueryString;
                    }
                }
                
                var method = nodeMethod.toUpperCase();

                var opts = {};
                // set defaultport, else when using HttpsProxyAgent, it's defaultPort of 443 will be used :(.
                // Had to remove this to get http->https redirect to work
                // opts.defaultPort = isHttps?443:80;
                opts.timeout = node.reqTimeout;
                opts.throwHttpErrors = false;
                // TODO: add UI option to auto decompress. Setting to false for 1.x compatibility
                opts.decompress = false;
                opts.method = method;
                opts.headers = {};
                opts.retry = 0;
                opts.responseType = 'buffer';
                opts.maxRedirects = 21;
                opts.cookieJar = new CookieJar();
                opts.ignoreInvalidCookies = true;
                opts.forever = nodeHTTPPersistent;
                if (msg.requestTimeout !== undefined) {
                    if (isNaN(msg.requestTimeout)) {
                        node.warn(RED._("Timeout value is not a valid number, ignoring"));
                    } else if (msg.requestTimeout < 1) {
                        node.warn(RED._("Timeout value is negative, ignoring"));
                    } else {
                        opts.timeout = msg.requestTimeout;
                    }
                }
                const originalHeaderMap = {};

                opts.hooks = {
                    beforeRequest: [
                        options => {
                            // Whilst HTTP headers are meant to be case-insensitive,
                            // in the real world, there are servers that aren't so compliant.
                            // GOT will lower case all headers given a chance, so we need
                            // to restore the case of any headers the user has set.
                            Object.keys(options.headers).forEach(h => {
                                if (originalHeaderMap[h] && originalHeaderMap[h] !== h) {
                                    options.headers[originalHeaderMap[h]] = options.headers[h];
                                    delete options.headers[h];
                                }
                            })
                        }
                    ],
                    beforeRedirect: [
                        (options, response) => {
                            let redirectInfo = {
                                location: response.headers.location
                            }
                            if (response.headers.hasOwnProperty('set-cookie')) {
                                redirectInfo.cookies = extractCookies(response.headers['set-cookie']);
                            }
                            redirectList.push(redirectInfo)
                        }
                    ]
                }

                var ctSet = "Content-Type"; // set default camel case
                var clSet = "Content-Length";
                if (msg.headers) {
                    if (msg.headers.hasOwnProperty('x-node-red-request-node')) {
                        var headerHash = msg.headers['x-node-red-request-node'];
                        delete msg.headers['x-node-red-request-node'];
                        var hash = hashSum(msg.headers);
                        if (hash === headerHash) {
                            delete msg.headers;
                        }
                    }
                    if (msg.headers) {
                        for (var v in msg.headers) {
                            if (msg.headers.hasOwnProperty(v)) {
                                var name = v.toLowerCase();
                                if (name !== "content-type" && name !== "content-length") {
                                    // only normalise the known headers used later in this
                                    // function. Otherwise leave them alone.
                                    name = v;
                                }
                                else if (name === 'content-type') { ctSet = v; }
                                else { clSet = v; }
                                opts.headers[name] = msg.headers[v];
                            }
                        }
                    }
                }

                if (msg.hasOwnProperty('followRedirects')) {
                    opts.followRedirect = !!msg.followRedirects;
                }

                if (opts.headers.hasOwnProperty('cookie')) {
                    var cookies = cookie.parse(opts.headers.cookie, { decode: String });
                    for (var name in cookies) {
                        opts.cookieJar.setCookieSync(cookie.serialize(name, cookies[name], { encode: String }), url, { ignoreError: true });
                    }
                    delete opts.headers.cookie;
                }
                if (msg.cookies) {
                    for (var name in msg.cookies) {
                        if (msg.cookies.hasOwnProperty(name)) {
                            if (msg.cookies[name] === null || msg.cookies[name].value === null) {
                                // This case clears a cookie for HTTP In/Response nodes.
                                // Ignore for this node.
                            } else if (typeof msg.cookies[name] === 'object') {
                                if (msg.cookies[name].encode === false) {
                                    // If the encode option is false, the value is not encoded.
                                    opts.cookieJar.setCookieSync(cookie.serialize(name, msg.cookies[name].value, { encode: String }), url, { ignoreError: true });
                                } else {
                                    // The value is encoded by encodeURIComponent().
                                    opts.cookieJar.setCookieSync(cookie.serialize(name, msg.cookies[name].value), url, { ignoreError: true });
                                }
                            } else {
                                opts.cookieJar.setCookieSync(cookie.serialize(name, msg.cookies[name]), url, { ignoreError: true });
                            }
                        }
                    }
                }
            
                // revert to user supplied Capitalisation if needed.
                if (opts.headers.hasOwnProperty('content-type') && (ctSet !== 'content-type')) {
                    opts.headers[ctSet] = opts.headers['content-type'];
                    delete opts.headers['content-type'];
                }
                if (opts.headers.hasOwnProperty('content-length') && (clSet !== 'content-length')) {
                    opts.headers[clSet] = opts.headers['content-length'];
                    delete opts.headers['content-length'];
                }


                // Now we have established all of our own headers, take a snapshot
                // of their case so we can restore it prior to the request being sent.
                if (opts.headers) {
                    Object.keys(opts.headers).forEach(h => {
                        originalHeaderMap[h.toLowerCase()] = h
                    })
                }
                
                got(url, opts).then(res => {
                    msg.statusCode = res.statusCode;
                    msg.headers = res.headers;
                    msg.responseUrl = res.url;
                    msg.payload = res.body;
                    msg.redirectList = redirectList;
                    msg.retry = 0;

                    if (msg.headers.hasOwnProperty('set-cookie')) {
                        msg.responseCookies = extractCookies(msg.headers['set-cookie']);
                    }
                    msg.headers['x-node-red-request-node'] = hashSum(msg.headers);
                    // msg.url = url;   // revert when warning above finally removed
                    if (node.metric()) {
                        // Calculate request time
                        var diff = process.hrtime(preRequestTimestamp);
                        var ms = diff[0] * 1e3 + diff[1] * 1e-6;
                        var metricRequestDurationMillis = ms.toFixed(3);
                        node.metric("Milliseconds", msg, metricRequestDurationMillis);
                        if (res.client && res.client.bytesRead) {
                            node.metric("size.bytes", msg, res.client.bytesRead);
                        }
                        if (timingLog) {
                            emitTimingMetricLog(res.timings, msg);
                        }
                    }
                    // Convert the payload to the required return type
                    msg.payload = msg.payload.toString('utf8'); // txt

                    node.status({});
                    node.send(msg);
                    // nodeDone();
                }).catch(err => {
                    // Pre 2.1, any errors would be sent to both Catch node and sent on as normal.
                    // This is not ideal but is the legacy behaviour of the node.
                    // 2.1 adds the 'senderr' option, if set to true, will *only* send errors
                    // to Catch nodes. If false, it still does both behaviours.
                    // TODO: 3.0 - make it one or the other.
                    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                        node.error(RED._("no response from server"), err.code);
                        node.status({ fill: "red", shape: "ring", text: "no response from server" });
                    } else {
                        node.error(err, err.code);
                        node.status({ fill: "red", shape: "ring", text: err.code });
                    }
                    msg.payload = err.toString() + " : " + url;
                    msg.statusCode = err.code || (err.response ? err.response.statusCode : undefined);
                    if (node.metric() && timingLog) {
                        emitTimingMetricLog(err.timings, msg);
                    }
                    // if (!sendErrorsToCatch) {
                    //     node.send(msg);
                    // }
                    // nodeDone();
                });
            }, requestInterval);
            return interval_id;
        }
    }

    RED.nodes.registerType("video input", VideoInputNode);

    RED.httpAdmin.post("/video-input/:id/:state", RED.auth.needsPermission("video-input.write"), function (req, res) {
        var state = req.params.state;
        var node = RED.nodes.getNode(req.params.id);
        if (node === null || typeof node === "undefined") {
            res.sendStatus(404);
            return;
        }

        var message = {}
        message.action = state === "enable";

        if (state === "enable") {
            node.active = true;
            res.send('activated');
        }
        else if (state === "disable") {
            node.active = false;
            res.send('deactivated');
        }
        node.receive(message);

    });
    
}
