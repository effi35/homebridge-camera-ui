'use strict';

const Logger = require('../../lib/logger.js');

const Telegram = require('./telegram');
const record = require('./record');
const socket = require('../server/socket');

const crypto = require('crypto');
const got = require('got');
const moment = require('moment');
const Rekognition = require('node-rekognition');  
const URL = require('url').URL;
const webpush = require('web-push');

const cleartimer = require('./cleartimer');

const stringIsAValidUrl = (s) => {
  try {
    let url = new URL(s);
    return url;
  } catch (err) {
    return false;
  }
};

var database, webpushhh, telegramCredentials, telegramBot, streamSessions, rekognition;  

module.exports = {

  init(db, sessions, awsCredentials){
  
    database = db;
    streamSessions = sessions;
    
    if(awsCredentials){
    
      try {
        rekognition = new Rekognition(awsCredentials);
      } catch(err) {
        Logger.ui.error('Bad AWS credentials!');
        rekognition = false;
      }
    
    }

    telegramCredentials = {
      token: database.db.get('settings').get('telegram').get('token').value(),
      chatID: database.db.get('settings').get('telegram').get('chatID').value()
    };
    
    return;
  
  },
  
  handleMotion: async function(accessory, cameraConfig, active, type){
    
    const atHome = database.db.get('settings').get('general').get('atHome').value();
    const exclude = database.db.get('settings').get('general').get('exclude').value();
    const recPath = database.db.get('settings').get('recordings').get('path').value();
    const recTimer = database.db.get('settings').get('recordings').get('timer').value();
    
    if(active && (!atHome || atHome && exclude.includes(accessory.displayName))){
          
      Logger.ui.debug('New ' + (type === 'motion' ? 'Motion' : 'Doorbell') + ' Alert', accessory.displayName);
      
      //Motion Info
      const motionInfo = this.createMotionInfo(accessory);

      //Get Snapshot Buffer
      const imageBuffer = await record.getSnapshot(accessory.context.videoConfig); 

      let detected = accessory.context.rekognition && accessory.context.rekognition.active && rekognition
        ? await this.handleImageDetection(accessory, imageBuffer)
        : undefined;
        
      if(detected || detected === undefined){
      
        //Notification Info
        const notification = this.handleNotification(accessory, type, motionInfo, detected);
  
        //Recording Info
        const recording = this.handleRecording(accessory, type, notification, motionInfo);

        //Trigger webhook with information about accessory
        this.webHook(accessory, notification);

        if(motionInfo.record){

          //Send notification with picture before creating video
          this.teleGram(notification, accessory, motionInfo.record, imageBuffer);

          //Store Snapshot/Video
          await record.storeSnapshot(recording.camera, imageBuffer, recording.info, recPath, true);
          await record.storeVideo(recording.camera, recording.info, recPath, recTimer);
          
          streamSessions.closeSession(accessory.displayName);
          
          socket.io('notification', notification);
          socket.storeNots(notification);
          this.webPush(notification, accessory);  
          
        } else {

          //Store Snapshot
          await record.storeSnapshot(recording.camera, imageBuffer, recording.info, recPath, false);
          
          socket.io('notification', notification);
          socket.storeNots(notification);
          this.webPush(notification, accessory);  
          this.teleGram(notification, accessory, motionInfo.record);
          
        }
        
      } else {
      
        Logger.ui.debug('Skip storing movement. Configured label not detected.', accessory.displayName);
      
      }

    } else {
      
      if(active && atHome && !exclude.includes(accessory.displayName)){
      
        Logger.ui.debug('Skip motion trigger. At Home is active and ' + accessory.displayName + ' is not excluded!');
     
      }
      
    }
  
  },
  
  createMotionInfo: function(accessory){
  
    const recActive = database.db.get('settings').get('recordings').get('active').value();
  
    let recordNotification = recActive ? streamSessions.requestSession(accessory.displayName) : false;

    let time = {
      time: moment().format('DD.MM.YYYY, HH:mm:ss'),
      timestamp: moment().unix()
    };
    
    let rndm = crypto.randomBytes(5).toString('hex');
    
    return {
      record: recordNotification,
      time: time,
      hash: rndm
    };
  
  },
  
  handleNotification: function(accessory, type, notificationData, detected){
    
    let notification = database.Notifications().add(accessory, type, notificationData.time, notificationData.hash, notificationData.record, detected);
    
    //clearTimer
    let notTimer = database.db.get('settings').get('notifications').get('clearTimer').value();
    notTimer = isNaN(parseInt(notTimer)) ? false : parseInt(notTimer);
    
    if(notTimer)
      cleartimer.setNotification(notification.id, notTimer);
      
    return notification; 
  
  },
  
  handleRecording: function(accessory, type, notification, notificationData){

    let camera = database.Recordings().add(accessory, type, notificationData.time, notificationData.hash, notification.labels); 
    
    //clearTimer
    let recTimer = database.db.get('settings').get('recordings').get('removeAfter').value();
    recTimer = isNaN(parseInt(recTimer)) ? false : parseInt(recTimer);
    
    if(recTimer)
      cleartimer.setRecording(notification.id, recTimer);  
      
    return camera; 
  
  },
  
  handleImageDetection: async function(accessory, imgBuffer){
    
    try {
    
      Logger.ui.debug('Analyzing image for following labels: ' + accessory.context.rekognition.labels.toString(), accessory.displayName);
    
      const imageLabels = await rekognition.detectLabels(imgBuffer);
      let detected = imageLabels.Labels.filter(label => label && accessory.context.rekognition.labels.includes(label.Name.toLowerCase()) && label.Confidence >= accessory.context.rekognition.confidence).map(label => label.Name);
      
      Logger.ui.debug('Label with confidence >= ' + accessory.context.rekognition.confidence + '% ' + (detected ? 'found: ' + detected.toString() : 'not found!'), accessory.displayName);
      
      if(!detected.length){
        Logger.ui.debug(imageLabels);     //for debugging
        detected = false;
      }
      
      return detected;
      
    } catch(err){
    
      Logger.ui.error('Can not analyze image, an error occured!');
      Logger.ui.error(err.message);
      
      return false;
    
    }
  
  },

  webHook: async function(accessory, notification){
    
    const webhook = database.db.get('settings').get('webhook').value();
    
    if(webhook.active && webhook.cameras[accessory.displayName].endpoint && webhook.cameras[accessory.displayName].endpoint !== ''){

      let validUrl = stringIsAValidUrl(webhook.cameras[accessory.displayName].endpoint);

      if(validUrl){
      
        Logger.ui.debug('Trigger Webhook endpoint ' + webhook.cameras[accessory.displayName].endpoint, accessory.displayName);
        
        try {
          
          let config = {
            method: 'POST',
            responseType: 'json',
            json: notification
          };
          
          await got(webhook.cameras[accessory.displayName].endpoint, config);
          
          Logger.ui.debug('Payload was sent successfully to ' + webhook.cameras[accessory.displayName].endpoint, accessory.displayName);
          
        } catch(err){
          
          Logger.ui.error('Error: ' + err.message, accessory.displayName);
          
        }
      
      } else {
     
        Logger.ui.warn('The given endpoint is not a valid URL! Please check your endpoint!');
     
      }
    
    }
    
  },
  
  teleGram: async function(notification, accessory, recordNotification, imageBuffer){ 
    
    const tlgrm = database.db.get('settings').get('telegram').value();
    const tlgrmCameraType = tlgrm.cameras[accessory.displayName].type;
    const recType = database.db.get('settings').get('recordings').get('type').value();
    
    if(imageBuffer && (!tlgrmCameraType === 'Snapshot' || !recordNotification))
      return;
    
    if((tlgrmCameraType === 'Text')||(tlgrmCameraType === 'Snapshot' && recordNotification)||(tlgrmCameraType === 'Video' && recordNotification && recType === 'Video')){
      
      const recPath = database.db.get('settings').get('recordings').get('path').value();
        
      if(tlgrm.active && tlgrm.token && tlgrm.chatID){
        
        if(tlgrm.token === telegramCredentials.token && tlgrm.chatID === telegramCredentials.chatID){
          
          //credentials not changed, grab telegram from storage or create new one if not exists
          
          if(!telegramBot)
            telegramBot = await Telegram.start(tlgrm);
          
        } else {
          
          //credentials changed, stop telegram from storage if exists and create new one
          
          telegramCredentials = {
            token: tlgrm.token,
            chatID: tlgrm.chatID
          };
          
          if(telegramBot){
            await Telegram.stop(telegramBot);
            telegramBot = false;
          }
          
          telegramBot = await Telegram.start(tlgrm);
          
        }
        
        let motionTxt = tlgrm.motionOn && tlgrm.motionOn !== '' ? tlgrm.motionOn : false;
        
        motionTxt = motionTxt && motionTxt.includes('@') ? motionTxt.replace('@', accessory.displayName) : (accessory.displayName + ': New motion detected!');
        
        if(imageBuffer && tlgrmCameraType === 'Snapshot' && recordNotification){
          
          Telegram.send(telegramBot, tlgrm, {
            buffer: true,
            img: imageBuffer
          });
          
        } else {
          
          Telegram.send(telegramBot, tlgrm, {
            message: tlgrmCameraType === 'Text' ? true : false,
            photo: tlgrmCameraType === 'Snapshot' && recordNotification ? true : false,
            video: tlgrmCameraType === 'Video' && recordNotification && recType === 'Video' ? true : false,
            txt: motionTxt,
            img: tlgrmCameraType === 'Snapshot' && recType === 'Video' ? recPath + '/' + notification.id + '@2.jpeg' : recPath + '/' + notification.id + '.jpeg',
            vid: recPath + '/' + notification.id + '.mp4'
          });
          
        }
        
      }
      
    }
    
  },
  
  webPush: async function(notification, accessory){
    
    const web_push = database.db.get('settings').get('webpush').value();
      
    if(!webpushhh){
      webpushhh = true;
      webpush.setVapidDetails('mailto:example@yourdomain.org', web_push.pub_key, web_push.priv_key);
    }
    
    let webpush_not = {
      ...notification,
      detect_info: 'detected a new movement on'
    };
    
    if(web_push.subscription){
      Logger.ui.debug('Sending new webpush notification', accessory.displayName);
      webpush.sendNotification(web_push.subscription, JSON.stringify(webpush_not))
        .catch(async error => {
          if(error.statusCode === 410){
            Logger.ui.debug('Web-Push Notification Grant changed! Removing subscription..');
            await database.Settings().update(false, false, false, false, false, false, false, false, false, {
              pub_key: web_push.pub_key,
              priv_key: web_push.priv_key,
              subscription: false
            });
          } else {
            Logger.ui.error('An error occured during sending Wep-Push Notification!');
            Logger.ui.error(error.body);
          }
        });
    }
    
  }

};
