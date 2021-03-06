var util = require('../../helpers/util.js');

module.exports = function() {

    global.app.post('/server/url', function(req, res) { //get the app object containing keys
        try {
            console.log("++++ Change Server URL ++++++");
            console.log("New URL : "+req.body.url);
            if (!util.isUrlValid(req.body.url)) {
                return res.status(400).send("Invalid URL");
            }

            if (global.keys.secureKey === req.body.secureKey) {
                console.log("Secure Key Valid. Creating app...");
                global.keyService.changeUrl(req.body.url).then(function (url) {
                    console.log("URL Updated to "+url);
                    res.status(200).send({status : "success", message : "Cluster URL Updated to "+url});
                }, function (err) {
                    console.log("Error : Cannot change the URL");
                    console.log(err);
                    res.status(500).send("Error, Cannot change the cluster URL at this time.");
                });
            } else {
                console.log("Unauthorized: Invalid Secure Key ");
                res.status(401).send("Unauthorized");
            }
        }catch(e){
            console.log(e);
            res.send(500, "Internal Server Error");
        }
    });
};