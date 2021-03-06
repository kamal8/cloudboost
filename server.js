var express = require('express');
global.request = require('request');
var pjson = require('./package.json');
var fs = require('fs');

try{
  global.config = require('./config/cloudboost');
}catch(e){
  //if this module is not found then,
  global.config = null;
}

global.mongoDisconnected = false;
global.elasticDisconnected = false;
global.winston = require('winston');
require('winston-loggly');

global.keys = require('./database-connect/keys.js')();

global.winston.add(global.winston.transports.Loggly, {
    token: global.keys.logToken,
    subdomain: "cloudboost",
    tags: ["NodeJS"],
    json:true
});

global.keyService = require('./database-connect/keyService.js');

global.q = require('q');
global.uuid=require('uuid');
var bodyParser = require('body-parser');
var cookies = require("cookies");
var session = require('express-session');
global.app = express();
var http = require('http').Server(global.app);
require('./database-connect/cors.js')(); //cors!
var io = require('socket.io')(http);
var multer = require('multer');
var Redis = require('ioredis');

var ioRedisAdapter = require('socket.io-redis');

global.sessionHelper = require('./helpers/session.js');
global.socketSessionHelper = require('./helpers/socketSession.js');
global.cloudBoostHelper = require('./helpers/cloudboost.js')();
global.aclHelper = require('./helpers/ACL.js');

//setting socket.io redis store.
global.mongoService = null;
global.customService = null;
global.userService = null;
global.appService = null;
global.fileService = null;
global.queueService = null;

global.mongoUtil = null;
global.elasticSearchUtil = null;

global.cacheService = null;
global.cacheItems = [];
global.apiTracker = null;

global.model = {};

app.use(bodyParser.urlencoded({ extended: true}));
app.use(bodyParser.json());

global.app.use(multer({
	dest: './uploads/'
}));

global.app.use(function(req, res, next){
    if (req.is('text/*')) {
        req.text = '';
        req.setEncoding('utf8');
        req.on('data', function(chunk){ req.text += chunk });
        req.on('end', next);
    } else {
        next();
    }
});

//This middleware converts text to JSON.
global.app.use(function(req,res,next){
   try{
       req.body = JSON.parse(req.text);
       next();
   }catch(e){
        //cannot convert to JSON.
       next();
   }
});

global.app.use(['/file/:appId', '/data/:appId', '/user/:appId','/cache/:appId', '/queue/:appId'], function (req, res, next) {
 	 //This is the Middleware for authenticating the app access using appID and key
 	 //check if all the services are loaded first.

     if(!customService || !mongoService || !userService || !roleService || !appService || !fileService || !cacheService){
         return res.status(400).send("Services Not Loaded");
     }

     console.log('Checking if API Key is valid...');
     
     if(req.text)
     {
         req.body=JSON.parse(req.text);
     }
 	 
      var requestRecvd = req.originalUrl; //this is the relative url.
 	if (ignoreUrl(requestRecvd)) {
 		next();
 	} else {

 		var appKey = req.body.key || req.params.key; //key is extracted from body/url parameters

 		var appId = req.params.appId;
 		if (!appKey) {
 			return res.status(401).send("Error : Key not found.");
 		} else {
 			global.appService.isKeyValid(appId, appKey).then(function(result) {
 				if (!result) {
 					return res.status(401).send("App ID or App Key is invalid.");
 				} else {
 					next();
 				}
 			}, function(err) {
                 global.winston.log('error',err);
 				return res.status(500).send(err.message);
 			});
 		}
 	}
 });

global.app.use(function(req,res,next) {

    // Middleware for retrieving sessions
    console.log('Session Middleware');
    
    res.header('Access-Control-Expose-Headers','sessionID');
    
    if(req.headers.sessionid) {
        console.log('Session Found.');
        res.header('sessionID',req.headers.sessionid);
        global.sessionHelper.getSession(req.headers.sessionid,function(err,session){
            if(!err) {
                    req.session = session;
                    next();
            }
            else{
                console.log(err);
                req.session = {};
                req.session.id = req.header.sessionid;
                next();
            }
        });
    } else {
        console.log('No Session Found. Creating a new session.');
        _setSession(req,res);
        next();
    }
    
});

//Attach services -
function attachServices() {
    try {
        if(!global.mongoClient){
            console.log("Error : Could Not Attach Services Mongo DB not loaded.");
            return;
        }
    
        //loading utils
        global.mongoUtil = require('./dbUtil/mongo')();
        global.elasticSearchUtil = require('./dbUtil/elasticSearch')();
        global.apiTracker = require('./database-connect/apiTracker')();
    
        //loading services.
        global.elasticSearchService = require('./databases/elasticSearch.js')();
        global.mongoService = require('./databases/mongo.js')();
        global.customService = require('./services/custom.js')();
        global.userService = require('./services/user.js')();
        global.roleService = require('./services/role.js')();
        global.appService = require('./services/app.js')();
        global.queueService = require('./services/queue.js')();
        global.fileService = require('./services/file.js')();
        global.cacheService = require('./services/cache.js')();
        console.log('+++++++++++ Services Status : OK. ++++++++++++++++++');
    }catch(e){
        console.log("FATAL : Cannot attach services");
        console.log(e);
    }

}


//Attach API's
function attachAPI() {

    try{        

        if (!global.mongoClient || !customService || !mongoService || !userService || !roleService || !appService || !fileService || !global.cacheService) {
            console.log("Failed to attach API's because services not loaded properly.");
            return;
        }
    
        require('./api/tables/Custom.js')();
        require('./api/tables/User.js')();
        require('./api/tables/Role.js')();
        require('./api/app/App.js')();
        require('./api/file/File.js')();
        require('./api/queue/Queue.js')();
        require('./api/cache/Cache.js')();
        require('./api/server/Server.js')();

        console.log('+++++++++++ API Status : OK ++++++++++++++++++');

        app.use(function(err, req, res, next) {
            if(err.status !== 500) {
                return next();
            }

            console.log("FATAL : Internal Server Error");
            console.log(err);

            res.statusCode(500).send({status : "500", message: "Internal Server Error" });
        });

        console.log("CloudBoost Server Started on PORT : " + app.get('port'));
    }catch(e){
        console.log("FATAL : Error attaching API. ");
        console.log(e);
    }
}

function ignoreUrl(requestUrl) {

	var ignoreUrl = [ //for the routes to check whether the particular service is active/not
		"/api/userService", "/api/customService", "/api/roleService", "/api/status", "/file","/api/createIndex"
	];

	for (var i = 0; i < ignoreUrl.length; i++) {
		if (requestUrl.indexOf(ignoreUrl[i]) >= 0) {
			return true;
		}
	}

	return false;
}

/*
Routes:
 */

app.get('/', function (req, res) {
    console.log('INDEX PAGE RETURNED.');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ status : 200, version : pjson.version }));
});


app.get('/getFile/:filename', function(req, res) { //for getting any file from resources/
	res.sendFile("resources/" + req.params.filename, {
		root: __dirname
	});
});

app.set('port', 4730); //SET THE DEFAULT PORT.

//Server kickstart:
http.listen(app.get('port'), function () {
    try {
        console.log("Server Init...");
        console.log("Data Connections Init...");
        addConnections();
        console.log("Services Init...");
        servicesKickstart();
    } catch (e) {
        console.log("ERROR : Server init error.");
        console.log(e);
    }

});

//this fucntion add connections to the DB.
function addConnections(){ 
   //MONGO DB
   setUpMongoDB();
   //setUp Redis
   setUpRedis();
   //ELASTIC SEARCH
   setUpElasticSearch();
}

function setUpRedis(){
   //Set up Redis.
 

   if(!global.config && !process.env["REDIS_1_PORT_6379_TCP_ADDR"] && !process.env["REDIS_SENTINEL_SERVICE_HOST"]){
      console.error("FATAL : Redis Cluster Not found. Use docker-compose from https://github.com/cloudboost/docker or Kubernetes from https://github.com/cloudboost/kubernetes");
   }

   var hosts = [];
   
   var isCluster = false;

   if(global.config && global.config.redis && global.config.redis.length>0){
       //take from config file
       for(var i=0;i<global.config.redis.length;i++){
           hosts.push({
                host : global.config.redis[i].host,
                port : global.config.redis[i].port,
                enableReadyCheck : false
           });
           
           if(global.config.redis[i].password){
               hosts[i].password = global.config.redis[i].password;
           }
       }
       
       if(global.config.redis.length>1){
           isCluster = true;
       }
       
   }else{
       
       if(process.env["REDIS_SENTINEL_SERVICE_HOST"]){
           //this is running on Kubernetes
           console.log("Redis is running on Kubernetes.");
           
           var obj = {
                        host : process.env["REDIS_SENTINEL_SERVICE_HOST"],
                        port : process.env["REDIS_SENTINEL_SERVICE_PORT"],
                        enableReadyCheck : false
                    };
           hosts.push(obj); 
       }else{
            //take from env variables.
            var i=1;
            while(process.env["REDIS_"+i+"_PORT_6379_TCP_ADDR"] && process.env["REDIS_"+i+"_PORT_6379_TCP_PORT"]){
                    if(i>1){
                        isCluster = true;
                    }
                    var obj = {
                        host : process.env["REDIS_"+i+"_PORT_6379_TCP_ADDR"],
                        port : process.env["REDIS_"+i+"_PORT_6379_TCP_PORT"],
                        enableReadyCheck : false
                    };
                    hosts.push(obj);       
                    i++;
            }
       }
   }
  
   console.log("Redis Connection String");
   console.log(hosts);
   
   if(isCluster){
        global.redisClient = new Redis.Cluster(hosts);
        
        io.adapter(ioRedisAdapter({
            pubClient: new Redis.Cluster(hosts),
            subClient: new Redis.Cluster(hosts)
        }));
        
   }else{
       global.redisClient = new Redis(hosts[0]);
       
       io.adapter(ioRedisAdapter({
            pubClient: new Redis(hosts[0]),
            subClient: new Redis(hosts[0])
       }));
   }
    
   global.realTime = require('./database-connect/realTime')(io);
}

function setUpElasticSearch(){

   var hosts = [];

   if(!global.config && !process.env["ELASTICSEARCH_1_PORT_9200_TCP_ADDR"] && !process.env["ELASTICSEARCH_SERVICE_HOST"]){
      console.error("FATAL : ElasticSearch Cluster Not found. Use docker-compose from https://github.com/cloudboost/docker or Kubernetes from https://github.com/cloudboost/kubernetes");
   }

   if(global.config && global.config.elasticsearch && global.config.elasticsearch.length>0){
       //take from config file
       
       for(var i=0;i<global.config.elasticsearch.length;i++){
           hosts.push(
                global.config.elasticsearch[i].host +":"+global.config.elasticsearch[i].port
           );
       }
       
       global.keys.elasticSearch = hosts;
       
   }else{
       
       if(process.env["ELASTICSEARCH_SERVICE_HOST"]){
           //this is running on Kubernetes
           console.log("ELASTICSEARCH is running on Kubernetes.");
           
           if(!global.keys.elasticSearch || global.keys.elasticSearch.length===0){
               global.keys.elasticSearch = [];
           }
           
           global.keys.elasticSearch.push(process.env["ELASTICSEARCH_SERVICE_HOST"]+":"+process.env["ELASTICSEARCH_SERVICE_PORT"]); 
       }else{
            //ELASTIC SEARCH. 
            var i=1;
            
            global.keys.elasticSearch = [];

            while(process.env["ELASTICSEARCH_"+i+"_PORT_9200_TCP_ADDR"] && process.env["ELASTICSEARCH_"+i+"_PORT_9200_TCP_PORT"]){
                global.keys.elasticSearch.push(process.env["ELASTICSEARCH_"+i+"_PORT_9200_TCP_ADDR"]+":"+process.env["ELASTICSEARCH_"+i+"_PORT_9200_TCP_PORT"]); 
                i++;
            }
       }
      
   } 
   
   console.log("Elastic Search Connection String");
   console.log(global.keys.elasticSearch);
}

function setUpMongoDB(){
   //MongoDB connections. 

   if(!global.config && !process.env["MONGO_1_PORT_27017_TCP_ADDR"] && !process.env["MONGO_SERVICE_HOST"]){
      console.error("FATAL : MongoDB Cluster Not found. Use docker-compose from https://github.com/cloudboost/docker or Kubernetes from https://github.com/cloudboost/kubernetes");
   }

   var mongoConnectionString = "mongodb://";
   
   var isReplicaSet = false;
   
   if(global.config && global.config.mongo && global.config.mongo.length>0){
       //take from config file
       
       if(global.config.mongo.length>1){
           isReplicaSet = true;
       }
       
       for(var i=0;i<global.config.mongo.length;i++){
            mongoConnectionString+=global.config.mongo[i].host +":"+global.config.mongo[i].port;
            mongoConnectionString+=",";
       }

   }else{
        
        if(!global.config){
            global.config = {};
        }

        global.config.mongo = []; 
        
       if(process.env["MONGO_SERVICE_HOST"]){
            console.log("MongoDB is running on Kubernetes");
           
            global.config.mongo.push({
                host :  process.env["MONGO_SERVICE_HOST"],
                port : process.env["MONGO_SERVICE_PORT"]
            });

            mongoConnectionString+=process.env["MONGO_SERVICE_HOST"]+":"+process.env["MONGO_SERVICE_PORT"]; 
            mongoConnectionString+=",";
            
            isReplicaSet = true;
            
       }else{
            var i=1;
            
            while(process.env["MONGO_"+i+"_PORT_27017_TCP_ADDR"] && process.env["MONGO_"+i+"_PORT_27017_TCP_PORT"]){
                if(i>1){
                  isReplicaSet = true;
                }

                global.config.mongo.push({
                    host :  process.env["MONGO_"+i+"_PORT_27017_TCP_ADDR"],
                    port : process.env["MONGO_"+i+"_PORT_27017_TCP_PORT"]
                });

                mongoConnectionString+=process.env["MONGO_"+i+"_PORT_27017_TCP_ADDR"]+":"+process.env["MONGO_"+i+"_PORT_27017_TCP_PORT"]; 
                mongoConnectionString+=",";
                i++;
            }
       }
   }
  
   mongoConnectionString = mongoConnectionString.substring(0, mongoConnectionString.length - 1);
   mongoConnectionString += "/"; //de limitter. 
   global.keys.prodSchemaConnectionString = mongoConnectionString+global.keys.globalDb;
   global.keys.mongoConnectionString = mongoConnectionString;

   if(isReplicaSet){
       console.log("MongoDB is in ReplicaSet");
       var str = "?replicaSet=cloudboost&slaveOk=true";
       global.keys.prodSchemaConnectionString+=str;
       global.keys.mongoConnectionString+=str;
   }

   console.log("Mongo Global DB : "+global.keys.prodSchemaConnectionString);
   console.log("Mongo DB Server: "+global.keys.mongoConnectionString);
   
   var mongoose = require('./database-connect/schemaDb')();

   global.model.Project = require('./model/Project')(mongoose);
   global.model.Table = require('./model/Table')(mongoose);
}

//to kickstart database services
function servicesKickstart() {

    global.esClient = require('./database-connect/elasticSearchConnect.js')();
    var db = require('./database-connect/mongoConnect.js')().connect();
	  db.then(function(db){
        try{
            global.mongoClient = db;
            //Init Secure key for this cluster. Secure key is used for Encryption / Creating apps , etc.
            global.keyService.initSecureKey();
            //Cluster Key is used to differentiate which cluster is the request coming from in Analytics.
            global.keyService.initClusterKey();
            attachServices();
            attachAPI();
            if(!process.env.CBENV || process.env.CBENV === 'STAGING')
                attachDbDisconnectApi();
            attachCronJobs();
        }catch(e){
            console.log(e);
        }
    },function(err){
        console.log("Cannot connect to MongoDB.");
        console.log(err);
    });
}

function attachDbDisconnectApi(){
    require('./api/db/elasticSearch.js')();
    require('./api/db/mongo.js')();
}

function attachCronJobs() {
    require('./cron/expire.js');
}

function _setSession(req, res) {
    if(!req.session) {
        req.session = {};
        req.session.id = global.uuid.v1();
    }

    console.log('Attaching a session to the header '+ req.session.id);
    res.header('sessionID',req.session.id);

    var obj = {
        id : req.session.id,
        userId : null,
        loggedIn : false,
        appId : null,
        email : null,
        roles : null
    };

    req.session = obj;
    global.sessionHelper.saveSession(obj);
}