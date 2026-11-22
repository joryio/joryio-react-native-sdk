#import <React/RCTViewManager.h>

// <JoryioPlacement placementKey="..." /> (D444). The view is Swift
// (JoryioPlacementViewManager.swift); this exposes its props and events.
@interface RCT_EXTERN_MODULE(JoryioPlacementViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(placementKey, NSString)
RCT_EXPORT_VIEW_PROPERTY(showProducts, BOOL)
RCT_EXPORT_VIEW_PROPERTY(productButtonText, NSString)
RCT_EXPORT_VIEW_PROPERTY(productCardWidth, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(onPlacementRender, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlacementDeepLink, RCTDirectEventBlock)

@end
