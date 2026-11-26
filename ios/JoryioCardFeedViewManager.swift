import UIKit
import React
import Joryio
import JoryioUI

/// The native view behind `<JoryioCardFeed />` (D444 Phase 3): the iOS SDK's
/// own CardFeedViewController, so the feed, paging, viewability (viewed then
/// read), the clicked / dismissed reports and the link rule are exactly the
/// native ones - one implementation per platform. App deep links
/// (`myapp://...`) go to JS (`onCardDeepLink`, with the whole card); http(s)
/// opens in the system natively; any other scheme is never opened.
@objc(JoryioCardFeedViewManager)
class JoryioCardFeedViewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }

  override func view() -> UIView! {
    JoryioCardFeedHostView()
  }
}

final class JoryioCardFeedHostView: UIView {
  private let feed = CardFeedViewController()
  private var appeared = false

  @objc var onCardFeedRender: RCTDirectEventBlock?
  @objc var onCardDeepLink: RCTDirectEventBlock?

  @objc var emptyText: NSString? {
    didSet { feed.emptyText = (emptyText as String?) ?? "No messages yet" }
  }
  @objc var pinnedLabel: NSString? {
    didSet { feed.pinnedLabel = (pinnedLabel as String?) ?? "Pinned" }
  }
  @objc var dismissLabel: NSString? {
    didSet { feed.dismissLabel = (dismissLabel as String?) ?? "Dismiss" }
  }
  @objc var unreadLabel: NSString? {
    didSet { feed.unreadLabel = (unreadLabel as String?) ?? "Unread" }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    let content: UIView = feed.view
    content.translatesAutoresizingMaskIntoConstraints = false
    addSubview(content)
    NSLayoutConstraint.activate([
      content.topAnchor.constraint(equalTo: topAnchor),
      content.leadingAnchor.constraint(equalTo: leadingAnchor),
      content.trailingAnchor.constraint(equalTo: trailingAnchor),
      content.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    // The feed and the card cross as their toJson() text, the same JSON as
    // getCards, so JS hands onRender / onDeepLink the same CardFeed and Card
    // as every other Joryio SDK.
    feed.onRender = { [weak self] f in
      self?.onCardFeedRender?(["feed": Self.jsonText(f.toJson())])
    }
    feed.onDeepLink = { [weak self] url, card in
      self?.onCardDeepLink?(["url": url.absoluteString, "card": Self.jsonText(card.toJson())])
    }
  }

  required init?(coder: NSCoder) { nil }

  private static func jsonText(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
  }

  // The controller is not contained in a parent (React Native owns the view
  // tree), so its appearance - which subscribes to the feed and runs the
  // viewability timer - follows this view entering and leaving the window.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil, !appeared {
      appeared = true
      feed.beginAppearanceTransition(true, animated: false)
      feed.endAppearanceTransition()
    } else if window == nil, appeared {
      appeared = false
      feed.beginAppearanceTransition(false, animated: false)
      feed.endAppearanceTransition()
    }
  }
}
