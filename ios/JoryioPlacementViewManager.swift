import UIKit
import React
import Joryio
import JoryioUI

/// The native view behind `<JoryioPlacement placementKey="..." />` (D444): the
/// iOS SDK's own PlacementView, so fetching, viewability, the holdout and the
/// reports are exactly the native ones. Tells JS the content height
/// (`onPlacementRender`) so the JS component can size the spot - `collapse`
/// gives 0 - and hands `deep_link` buttons to JS (`onPlacementDeepLink`).
@objc(JoryioPlacementViewManager)
class JoryioPlacementViewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }

  override func view() -> UIView! {
    JoryioPlacementHostView()
  }
}

final class JoryioPlacementHostView: UIView {
  private let placement = PlacementView(placementKey: "")

  @objc var onPlacementRender: RCTDirectEventBlock?
  @objc var onPlacementDeepLink: RCTDirectEventBlock?

  @objc var placementKey: NSString = "" {
    didSet { placement.setPlacementKey(placementKey as String) }
  }

  // The built-in product cards row: the native PlacementView's properties.
  @objc var showProducts: Bool = true {
    didSet { placement.showProducts = showProducts }
  }

  @objc var productButtonText: NSString? {
    didSet { placement.productButtonText = productButtonText as String? }
  }

  @objc var productCardWidth: CGFloat = CGFloat(Placements.PLACEMENT_PRODUCT_CARD_WIDTH) {
    didSet { placement.productCardWidth = productCardWidth }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    placement.translatesAutoresizingMaskIntoConstraints = false
    addSubview(placement)
    NSLayoutConstraint.activate([
      placement.topAnchor.constraint(equalTo: topAnchor),
      placement.leadingAnchor.constraint(equalTo: leadingAnchor),
      placement.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
    placement.onRender = { [weak self] p in
      guard let self else { return }
      DispatchQueue.main.async {
        let width = self.bounds.width > 0 ? self.bounds.width : UIScreen.main.bounds.width
        let size = self.placement.systemLayoutSizeFitting(
          CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
          withHorizontalFittingPriority: .required,
          verticalFittingPriority: .fittingSizeLevel)
        self.onPlacementRender?([
          "placementKey": p.placementKey,
          "itemCount": p.items.count,
          "isControl": p.isControl,
          "emptyBehavior": p.emptyBehavior,
          "height": size.height,
        ])
      }
    }
    placement.onDeepLink = { [weak self] url, item in
      self?.onPlacementDeepLink?(["url": url.absoluteString, "itemId": item.id])
    }
  }

  required init?(coder: NSCoder) { nil }
}
