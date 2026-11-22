#import <React/RCTViewManager.h>

// <JoryioCardFeed /> (D444 Phase 3). The view is Swift
// (JoryioCardFeedViewManager.swift); this exposes its props and events.
@interface RCT_EXTERN_MODULE(JoryioCardFeedViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(emptyText, NSString)
RCT_EXPORT_VIEW_PROPERTY(pinnedLabel, NSString)
RCT_EXPORT_VIEW_PROPERTY(dismissLabel, NSString)
RCT_EXPORT_VIEW_PROPERTY(unreadLabel, NSString)
RCT_EXPORT_VIEW_PROPERTY(onCardFeedRender, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onCardDeepLink, RCTDirectEventBlock)

@end
