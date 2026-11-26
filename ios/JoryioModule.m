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

RCT_EXTERN_METHOD(identifyFromLink:(NSString *)url)

RCT_EXTERN_METHOD(reset)
RCT_EXTERN_METHOD(resetTo:(NSString *)anonymousId
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

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

RCT_EXTERN_METHOD(getPlacements:(NSArray *)keys
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(refreshPlacements:(NSArray *)keys)

RCT_EXTERN_METHOD(enablePlacementsUpdates)

RCT_EXTERN_METHOD(disablePlacementsUpdates)

RCT_EXTERN_METHOD(markPlacement:(NSString *)placementKey
                  itemId:(NSString *)itemId
                  action:(NSString *)action
                  elementId:(NSString *)elementId)

RCT_EXTERN_METHOD(getCards:(NSString *)cursor
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getUnreadCardCount:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(markCardViewed:(NSString *)cardId)

RCT_EXTERN_METHOD(markCardRead:(NSString *)cardId)

RCT_EXTERN_METHOD(markCardClicked:(NSString *)cardId)

RCT_EXTERN_METHOD(dismissCard:(NSString *)cardId)

RCT_EXTERN_METHOD(refreshCards)

RCT_EXTERN_METHOD(enableCardsUpdates)

RCT_EXTERN_METHOD(disableCardsUpdates)

RCT_EXTERN_METHOD(enableLinkHandler)

RCT_EXTERN_METHOD(disableLinkHandler)

RCT_EXTERN_METHOD(completeLink:(NSString *)linkId
                  handled:(BOOL)handled)

RCT_EXTERN_METHOD(getFlag:(NSString *)key
                  defaultValue:(id)defaultValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getBoolFlag:(NSString *)key
                  defaultValue:(BOOL)defaultValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getStringFlag:(NSString *)key
                  defaultValue:(NSString *)defaultValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getNumberFlag:(NSString *)key
                  defaultValue:(double)defaultValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getJsonFlag:(NSString *)key
                  defaultValue:(id)defaultValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getAllFlags:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(refreshFlags:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(enableFlagsUpdates)

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
