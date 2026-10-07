#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(JoryioModule, RCTEventEmitter)

RCT_EXTERN_METHOD(initialize:(NSString *)sdkKey
                  apiHost:(NSString *)apiHost
                  config:(NSDictionary *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(track:(NSString *)eventName
                  properties:(NSDictionary *)properties)

RCT_EXTERN_METHOD(trackScreen:(NSString *)screenName
                  properties:(NSDictionary *)properties)

RCT_EXTERN_METHOD(identify:(NSString *)userId)

RCT_EXTERN_METHOD(addAlias:(NSString *)aliasLabel
                  aliasName:(NSString *)aliasName)

RCT_EXTERN_METHOD(reset)

RCT_EXTERN_METHOD(optOut)
RCT_EXTERN_METHOD(wipeData)

RCT_EXTERN_METHOD(optIn)

RCT_EXTERN_METHOD(updateConsent:(NSString *)consent)

RCT_EXTERN_METHOD(getTrackingConsent:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(isUserOptedOut:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSubscription:(NSString *)channel
                  status:(NSString *)status)

RCT_EXTERN_METHOD(addToSubscriptionGroup:(NSString *)groupId
                  channel:(NSString *)channel)

RCT_EXTERN_METHOD(removeFromSubscriptionGroup:(NSString *)groupId
                  channel:(NSString *)channel)

RCT_EXTERN_METHOD(setAttributes:(NSDictionary *)attributes)

RCT_EXTERN_METHOD(setAttribute:(NSString *)key
                  value:(id)value)

RCT_EXTERN_METHOD(incrementAttribute:(NSString *)key
                  by:(id)by)

RCT_EXTERN_METHOD(unsetAttribute:(NSString *)key)

RCT_EXTERN_METHOD(reportPushDelivered:(NSString *)trackingId)
RCT_EXTERN_METHOD(registerPushToken:(NSString *)token
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unregisterPush)

RCT_EXTERN_METHOD(requestPushPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getPushPermissionStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(isPushEnabled:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(trackPushClick:(NSString *)trackingId)

RCT_EXTERN_METHOD(setSdkAuthenticationToken:(NSString *)token)

RCT_EXTERN_METHOD(enableInAppMessages:(NSArray *)capabilities)

RCT_EXTERN_METHOD(disableInAppMessages)

RCT_EXTERN_METHOD(ecommerce:(NSString *)method payload:(NSDictionary *)payload)

RCT_EXTERN_METHOD(submitInAppForm:(NSString *)campaignId
                  values:(NSDictionary *)values
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(trackInAppImpression:(NSString *)campaignId
                  action:(NSString *)action
                  elementId:(NSString *)elementId)

RCT_EXTERN_METHOD(flush)

RCT_EXTERN_METHOD(getAnonymousId:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(syncInAppCampaigns)

RCT_EXTERN_METHOD(resetDisplayedCampaigns)

RCT_EXTERN_METHOD(getDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getUserId:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getSessionId:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end
