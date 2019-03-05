import {
  ObserverLocator,
  Scope,
  Expression,
  ICollectionObserverSplice,
  OverrideContext,
  BindingExpression
} from 'aurelia-binding';
import {
  BoundViewFactory,
  ViewSlot,
  ViewResources,
  TargetInstruction,
  View,
  IStaticResourceConfig
} from 'aurelia-templating';
import {
  AbstractRepeater,
  getItemsSourceExpression,
  isOneTime,
  unwrapExpression,
  updateOneTimeBinding,
  viewsRequireLifecycle
} from 'aurelia-templating-resources';
import { DOM, PLATFORM } from 'aurelia-pal';
import { TaskQueue } from 'aurelia-task-queue';
import { Container } from 'aurelia-dependency-injection';
import {
  calcOuterHeight,
  rebindAndMoveView,
  getStyleValues,
  Math$ceil,
  Math$floor,
  Math$max,
  Math$abs
} from './utilities';
import {
  getElementDistanceToTopOfDocument,
  hasOverflowScroll
} from './utilities-dom';
import { VirtualRepeatStrategyLocator } from './virtual-repeat-strategy-locator';
import { TemplateStrategyLocator } from './template-strategy-locator';
import {
  IVirtualRepeatStrategy,
  ITemplateStrategy,
  IView,
  IScrollNextScrollContext,
  IViewSlot,
  IScrollerInfo
} from './interfaces';

const enum VirtualRepeatCallContext {
  handleCollectionMutated = 'handleCollectionMutated',
  handleInnerCollectionMutated = 'handleInnerCollectionMutated'
}

export class VirtualRepeat extends AbstractRepeater {

  /**@internal */
  static inject() {
    // tslint:disable-next-line:max-line-length
    return [DOM.Element, Container, BoundViewFactory, TargetInstruction, ViewSlot, ViewResources, ObserverLocator, VirtualRepeatStrategyLocator, TemplateStrategyLocator];
  }

  /**@internal */
  static $resource(): IStaticResourceConfig {
    return {
      type: 'attribute',
      name: 'virtual-repeat',
      templateController: true,
      // Wrong typings in templating
      bindables: ['items', 'local'] as any
    };
  }

  /**
   * @internal
   * First view index, for proper follow up calculations
   */
  _first: number = 0;

  /**
   * @internal
   * Preview first view index, for proper determination of delta
   */
  _previousFirst = 0;

  /**@internal*/
  _viewsLength = 0;
  
  /**
   * @internal
   * Last rebound view index, user to determine first index of next task when scrolling/ changing viewport scroll position
   */
  _lastRebind = 0;

  /**
   * @internal
   * Height of top buffer to properly push the visible rendered list items into right position
   * Usually determined by `_first` visible index * `itemHeight`
   */
  _topBufferHeight = 0;

  /**
   * @internal
   * Height of bottom buffer to properly push the visible rendered list items into right position
   */
  _bottomBufferHeight = 0;

  /**@internal*/ _scrollingDown = false;
  /**@internal*/ _scrollingUp = false;
  /**@internal*/ _switchedDirection = false;
  /**@internal*/ _isAttached = false;
  /**@internal*/ _ticking = false;
  /**
   * @internal Indicates whether virtual repeat attribute is inside a fixed height container with overflow
   *
   * This helps identifies place to add scroll event listener
   */
  _fixedHeightContainer = false;

  /**@internal*/ _hasCalculatedSizes = false;

  /**
   * Indicate current scrolltop of scroller is 0 or less
   * @internal
   */
  _isAtTop = true;
  /**@internal*/ _calledGetMore = false;

  /**
   * While handling consecutive scroll events, repeater and its strategies may need to do
   * some of work that will not finish immediately in order to figure out visible effective elements / views.
   * There are scenarios when doing this too quickly is unnecessary
   * as there could be still some effect on going from previous handler.
   *
   * This flag is away to ensure a scroll handler always has a chance to
   * finish all the work it starts, no matter how user interact via scrolling
   * @internal
   */
  _skipNextScrollHandle: boolean = false;

  /**
   * While handling mutation, repeater and its strategies could/should modify scroll position
   * to deliver a smooth user experience. This action may trigger a scroll event
   * which may disrupt the mutation handling or cause unwanted effects.
   *
   * This flag is a way to tell the scroll listener that there are scenarios that
   * scroll event should be ignored
   * @internal
   */
  _handlingMutations: boolean = false;

  /**@internal*/ _isScrolling: boolean = false;

  // Inherited properties declaration
  key: any;
  value: any;
  // Array repeat specific properties
  /**@internal*/ __queuedSplices: any[];
  /**@internal*/ __array: any[];

  /**
   * @bindable
   */
  items: any[];

  /**
   * @bindable
   */
  local: string;

  /**@internal */
  scope: Scope;

  /**@internal */
  viewSlot: IViewSlot;

  readonly viewFactory: BoundViewFactory;

  /**@internal */
  element: HTMLElement;

  /**@internal */
  private instruction: TargetInstruction;

  /**@internal */
  private lookupFunctions: any;

  /**@internal */
  private observerLocator: ObserverLocator;

  /**@internal */
  private strategyLocator: VirtualRepeatStrategyLocator;

  /**@internal */
  private templateStrategyLocator: TemplateStrategyLocator;

  /**@internal */
  private sourceExpression: Expression;

  /**@internal */
  private isOneTime: boolean;

  /**
   * @internal
   * Temporary snapshot of items list count. Updated regularly to determinate calculation need
   */
  _prevItemsCount: number;

  /**@internal */
  scrollContainer: HTMLElement;

  /**@internal */
  private scrollListener: () => any;

  /**@internal */
  private _sizeInterval: any;

  /**@internal */
  private _calcDistanceToTopInterval: any;

  /**@internal */
  private taskQueue: TaskQueue;

  /**@internal */
  container: Container;

  templateStrategy: ITemplateStrategy;
  topBufferEl: HTMLElement;
  bottomBufferEl: HTMLElement;


  itemHeight: number;
  movedViewsCount: number;
  /**
   * Calculate current scrolltop position
   */
  distanceToTop: number;
  /**
   * When dealing with tables, there can be gaps between elements, causing distances to be messed up. Might need to handle this case here.
   */
  topBufferDistance: number;
  scrollContainerHeight: number;

  isLastIndex: boolean;
  elementsInView: number;

  strategy: IVirtualRepeatStrategy;
  ignoreMutation: boolean;

  /**@internal */
  callContext: VirtualRepeatCallContext;
  collectionObserver: any;

  constructor(
    element: HTMLElement,
    container: Container,
    viewFactory: BoundViewFactory,
    instruction: TargetInstruction,
    viewSlot: ViewSlot,
    viewResources: ViewResources,
    observerLocator: ObserverLocator,
    strategyLocator: VirtualRepeatStrategyLocator,
    templateStrategyLocator: TemplateStrategyLocator
  ) {
    super({
      local: 'item',
      viewsRequireLifecycle: viewsRequireLifecycle(viewFactory)
    });

    this.element = element;
    this.container = container;
    this.viewFactory = viewFactory;
    this.instruction = instruction;
    this.viewSlot = viewSlot as IViewSlot;
    this.lookupFunctions = viewResources['lookupFunctions'];
    this.observerLocator = observerLocator;
    this.taskQueue = observerLocator.taskQueue;
    this.strategyLocator = strategyLocator;
    this.templateStrategyLocator = templateStrategyLocator;
    this.sourceExpression = getItemsSourceExpression(this.instruction, 'virtual-repeat.for');
    this.isOneTime = isOneTime(this.sourceExpression);
    this.itemHeight = 0;
    this.topBufferDistance = 0;
    this._prevItemsCount = 0;
  }

  /**@override */
  bind(bindingContext: any, overrideContext: OverrideContext): void {
    this.scope = { bindingContext, overrideContext };
  }

  /**@override */
  attached(): void {
    this._isAttached = true;
    this._prevItemsCount = this.items.length;

    let element = this.element;
    let templateStrategy = this.templateStrategy = this.templateStrategyLocator.getStrategy(element);

    let scrollListener = this.scrollListener = () => this._onScroll();
    let scrollContainer = this.scrollContainer = templateStrategy.getScrollContainer(element);
    const [topBufferEl, bottomBufferEl] = templateStrategy.createBuffers(element);
    
    this.topBufferEl = topBufferEl;
    this.bottomBufferEl = bottomBufferEl;
    this.itemsChanged();

    this._calcDistanceToTopInterval = PLATFORM.global.setInterval(() => {
      let prevDistanceToTop = this.distanceToTop;
      let currDistanceToTop = getElementDistanceToTopOfDocument(topBufferEl) + this.topBufferDistance;
      this.distanceToTop = currDistanceToTop;
      if (prevDistanceToTop !== currDistanceToTop) {
        this._handleScroll();
      }
    }, 500);

    // When dealing with tables, there can be gaps between elements, causing distances to be messed up. Might need to handle this case here.
    this.topBufferDistance = templateStrategy.getTopBufferDistance(topBufferEl);
    this.distanceToTop = getElementDistanceToTopOfDocument(templateStrategy.getFirstElement(topBufferEl, bottomBufferEl));

    if (hasOverflowScroll(scrollContainer)) {
      this._fixedHeightContainer = true;
      scrollContainer.addEventListener('scroll', scrollListener);
    } else {
      DOM.addEventListener('scroll', scrollListener, false);
    }
    if (this.items.length < this.elementsInView && this.isLastIndex === undefined) {
      this._getMore(true);
    }
  }

  /**@override */
  call(context: 'handleCollectionMutated' | 'handleInnerCollectionMutated', changes: ICollectionObserverSplice[]): void {
    this[context](this.items, changes);
  }

  /**@override */
  detached(): void {
    const scrollCt = this.scrollContainer;
    const scrollListener = this.scrollListener;
    if (hasOverflowScroll(scrollCt)) {
      scrollCt.removeEventListener('scroll', scrollListener);
    } else {
      DOM.removeEventListener('scroll', scrollListener, false);
    }
    this.isLastIndex = undefined;
    this._fixedHeightContainer = false;
    this._resetCalculation();
    this._isAttached = false;
    this._prevItemsCount = 0;
    this.templateStrategy.removeBuffers(this.element, this.topBufferEl, this.bottomBufferEl);
    this.topBufferEl = this.bottomBufferEl = this.scrollContainer = this.scrollListener = null;
    this.scrollContainerHeight = 0;
    this.distanceToTop = 0;
    this.removeAllViews(/*return to cache?*/true, /*skip animation?*/false);
    this._unsubscribeCollection();
    const $clearInterval = PLATFORM.global.clearInterval;
    $clearInterval(this._calcDistanceToTopInterval);
    $clearInterval(this._sizeInterval);
    this._sizeInterval = this._calcDistanceToTopInterval = 0;
  }

  /**@override */
  unbind(): void {
    this.scope = null;
    this.items = null;
    this._prevItemsCount = 0;
  }

  /**
   * @override
   *
   * If `items` is truthy, do the following calculation/work:
   *
   * - container fixed height flag
   * - necessary initial heights
   * - create new collection observer & observe for changes
   * - invoke `instanceChanged` on repeat strategy to create views / move views
   * - update indices
   * - update scrollbar position in special scenarios
   * - handle scroll as if scroll event happened
   */
  itemsChanged(): void {
    // the current collection subscription may be irrelevant
    // unsubscribe and resubscribe later
    this._unsubscribeCollection();
    // still bound? and still attached?
    if (!this.scope || !this._isAttached) {
      return;
    }
    let reducingItems = false;
    let previousLastViewIndex = this._getIndexOfLastView();

    const items = this.items;
    const shouldCalculateSize = !!items;
    const strategy = this.strategy = this.strategyLocator.getStrategy(items);

    if (strategy === null) {
      throw new Error('Value is not iterateable for virtual repeat.');
    }

    if (shouldCalculateSize) {
      const currentItemCount = items.length;
      if (currentItemCount > 0 && this.viewCount() === 0) {
        strategy.createFirstItem(this);
      }
      // Skip scroll handling if we are decreasing item list
      // Otherwise if expanding list, call the handle scroll below
      if (this._prevItemsCount >= currentItemCount) {
        // Scroll handle is redundant in this case since the instanceChanged will re-evaluate orderings
        //  Also, when items are reduced, we're not having to move any bindings, just a straight rebind of the items in the list
        this._skipNextScrollHandle = true;
        reducingItems = true;
      }
      if (hasOverflowScroll(this.scrollContainer)) {
        this._fixedHeightContainer = true;
      }
      this._calcInitialHeights(currentItemCount);
    }
    if (!this.isOneTime && !this._observeInnerCollection()) {
      this._observeCollection();
    }
    strategy.instanceChanged(this, items, this._first);

    if (shouldCalculateSize) {
      const currentItemCount = items.length;
      // Reset rebinding
      this._lastRebind = this._first;

      if (reducingItems && previousLastViewIndex > currentItemCount - 1) {
        // Do we need to set scrolltop so that we appear at the bottom of the list to match scrolling as far as we could?
        // We only want to execute this line if we're reducing such that it brings us to the bottom of the new list
        // Make sure we handle the special case of tables
        // -------
        // Note: if branch is never the case anymore,
        // keeping this code to keep the history of logic for future work
        if (this.scrollContainer.tagName === 'TBODY') {
          // tbody > table > container
          let realScrollContainer = this.scrollContainer.parentNode.parentNode as Element;
          realScrollContainer.scrollTop = realScrollContainer.scrollTop + (this.viewCount() * this.itemHeight);
        } else {
          this.scrollContainer.scrollTop = this.scrollContainer.scrollTop + (this.viewCount() * this.itemHeight);
        }
      }
      if (!reducingItems) {
        // If we're expanding our items, then we need to reset our previous first for the next go around of scroll handling
        this._previousFirst = this._first;
        // Simulating the down scroll event to load up data appropriately
        this._scrollingDown = true;
        this._scrollingUp = false;

        // Make sure we fix any state (we could have been at the last index before, but this doesn't get set until too late for scrolling)
        this.isLastIndex = this._getIndexOfLastView() >= currentItemCount - 1;
      }

      // Need to readjust the scroll position to "move" us back to the appropriate position,
      // since moving the views will shift our view port's percieved location
      this._handleScroll();
    }
  }

  /**@override */
  handleCollectionMutated(collection: any[], changes: ICollectionObserverSplice[]): void {
    // guard against multiple mutation, or mutation combined with instance mutation
    if (this.ignoreMutation) {
      return;
    }
    this._handlingMutations = true;
    this._prevItemsCount = collection.length;
    this.strategy.instanceMutated(this, collection, changes);
  }

  /**@override */
  handleInnerCollectionMutated(collection: any[], changes: ICollectionObserverSplice[]): void {
    // guard against source expressions that have observable side-effects that could
    // cause an infinite loop- eg a value converter that mutates the source array.
    if (this.ignoreMutation) {
      return;
    }
    this.ignoreMutation = true;
    let newItems = this.sourceExpression.evaluate(this.scope, this.lookupFunctions);
    this.taskQueue.queueMicroTask(() => this.ignoreMutation = false);

    // call itemsChanged...
    if (newItems === this.items) {
      // call itemsChanged directly.
      this.itemsChanged();
    } else {
      // call itemsChanged indirectly by assigning the new collection value to
      // the items property, which will trigger the self-subscriber to call itemsChanged.
      this.items = newItems;
    }
  }

  /**
   * Get the real scroller element of the DOM tree this repeat resides in
   */
  getScroller(): HTMLElement {
    return this._fixedHeightContainer
      ? this.scrollContainer
      : document.documentElement;
  }

  /**
   * Get scrolling information of the real scroller element of the DOM tree this repeat resides in
   */
  getScrollerInfo(): IScrollerInfo {
    const scroller = this.getScroller();
    return {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      height: scroller.clientHeight
    };
  }

  /**@internal */
  _resetCalculation(): void {
    this._first
      = this._previousFirst
      = this._viewsLength
      = this._lastRebind
      = this._topBufferHeight
      = this._bottomBufferHeight
      = this.elementsInView = 0;
    this._scrollingDown
      = this._scrollingUp 
      = this._switchedDirection
      = this._ticking
      = this._hasCalculatedSizes
      = this.isLastIndex = false;
    this._isAtTop = true;
    this._updateBufferElements();
  }

  /**@internal*/
  _onScroll(): void {
    if (!this._ticking && !this._handlingMutations) {
      requestAnimationFrame(() => {
        this._handleScroll();
        this._ticking = false;
      });
      this._ticking = true;
    }

    if (this._handlingMutations) {
      this._handlingMutations = false;
    }
  }

  /**@internal*/
  _handleScroll(): void {
    if (!this._isAttached) {
      return;
    }
    if (this._skipNextScrollHandle) {
      this._skipNextScrollHandle = false;
      return;
    }
    const items = this.items;
    if (!items) {
      return;
    }
    const topBuffer = this.topBufferEl;
    const scroller = this.scrollContainer;
    const itemHeight = this.itemHeight;
    const topBufferDistance = topBuffer.offsetTop - scroller.offsetTop;
    const isFixedHeightContainer = this._fixedHeightContainer;
    /**
     * Real scroll top calculated based on current scroll top of scroller and top buffer {height + distance to top}
     * as there could be elements before top buffer and it affects real scroll top of the selected repeat
     * 
     * Calculation are done differently based on the scroller:
     * - not document: the scroll top of this repeat is calculated based on current scroller.scrollTop and the distance to top of `top buffer`
     * - document: the scroll top is the substraction of `pageYOffset` and distance to top of current buffer element (logic needs revised)
     */
    const scrollTop = isFixedHeightContainer
      ? scroller.scrollTop
      : (pageYOffset - this.distanceToTop);
    const realScrollTop = Math$max(0, isFixedHeightContainer ? scrollTop - Math$abs(topBufferDistance): scrollTop)
    const elementsInView = this.elementsInView;

    // Calculate the index of first view
    // Using Math floor to ensure it has correct space for both small and large calculation
    const firstIndex = Math$max(0, itemHeight > 0 ? Math$floor(realScrollTop / itemHeight) : 0);
    this._first = firstIndex;
    // if first index starts somewhere after the last view
    // then readjust based on the delta
    if (firstIndex > items.length - elementsInView) {
      this._first = Math$max(0, items.length - elementsInView);
    }

    // Check scrolling states and adjust flags
    this._checkScrolling();

    // store buffers' heights into local variables
    const currentTopBufferHeight = this._topBufferHeight;
    const currentBottomBufferHeight = this._bottomBufferHeight;

    // TODO if and else paths do almost same thing, refactor?
    if (this._scrollingDown) {
      let viewsToMoveCount = this._first - this._lastRebind;
      if (this._switchedDirection) {
        viewsToMoveCount = this._isAtTop ? this._first : (this._first - this._lastRebind);
      }
      this._isAtTop = false;
      this._lastRebind = this._first;
      let movedViewsCount = this._moveViews(viewsToMoveCount);
      let adjustHeight = movedViewsCount < viewsToMoveCount ? currentBottomBufferHeight : itemHeight * movedViewsCount;
      if (viewsToMoveCount > 0) {
        this._getMore();
      }
      this._switchedDirection = false;
      this._topBufferHeight = currentTopBufferHeight + adjustHeight;
      this._bottomBufferHeight = Math$max(currentBottomBufferHeight - adjustHeight, 0);
      if (this._bottomBufferHeight >= 0) {
        this._updateBufferElements();
      }
    } else if (this._scrollingUp) {
      let viewsToMoveCount = this._lastRebind - this._first;
      // Use for catching initial scroll state where a small page size might cause _getMore not to fire.
      let initialScrollState = this.isLastIndex === undefined;
      if (this._switchedDirection) {
        if (this.isLastIndex) {
          viewsToMoveCount = this.items.length - this._first - elementsInView;
        } else {
          viewsToMoveCount = this._lastRebind - this._first;
        }
      }
      this.isLastIndex = false;
      this._lastRebind = this._first;
      let movedViewsCount = this._moveViews(viewsToMoveCount);
      this.movedViewsCount = movedViewsCount;
      let adjustHeight = movedViewsCount < viewsToMoveCount
        ? currentTopBufferHeight
        : itemHeight * movedViewsCount;
      if (viewsToMoveCount > 0) {
        let force = this.movedViewsCount === 0 && initialScrollState && this._first <= 0 ? true : false;
        this._getMore(force);
      }
      this._switchedDirection = false;
      this._topBufferHeight = Math$max(currentTopBufferHeight - adjustHeight, 0);
      this._bottomBufferHeight = currentBottomBufferHeight + adjustHeight;
      if (this._topBufferHeight >= 0) {
        this._updateBufferElements();
      }
    }
    this._previousFirst = this._first;
    this._isScrolling = false;
  }

  /**@internal*/
  _getMore(force?: boolean): void {
    if (this.isLastIndex || this._first === 0 || force === true) {
      if (!this._calledGetMore) {
        let executeGetMore = () => {
          this._calledGetMore = true;
          let firstView = this._getFirstView();
          let scrollNextAttrName = 'infinite-scroll-next';
          let func: string | (BindingExpression & { sourceExpression: Expression }) = (firstView
            && firstView.firstChild
            && firstView.firstChild.au
            && firstView.firstChild.au[scrollNextAttrName])
              ? firstView.firstChild.au[scrollNextAttrName].instruction.attributes[scrollNextAttrName]
              : undefined;
          let topIndex = this._first;
          let isAtBottom = this._bottomBufferHeight === 0;
          let isAtTop = this._isAtTop;
          let scrollContext: IScrollNextScrollContext = {
            topIndex: topIndex,
            isAtBottom: isAtBottom,
            isAtTop: isAtTop
          };

          let overrideContext = this.scope.overrideContext;
          overrideContext.$scrollContext = scrollContext;

          if (func === undefined) {
            // Still reset `_calledGetMore` flag as if it was invoked
            // though this should not happen as presence of infinite-scroll-next attribute
            // will make the value at least be an empty string
            // keeping this logic here for future enhancement/evolution
            this._calledGetMore = false;
            return null;
          } else if (typeof func === 'string') {
            let getMoreFuncName = (firstView.firstChild as Element).getAttribute(scrollNextAttrName);
            let funcCall = overrideContext.bindingContext[getMoreFuncName];

            if (typeof funcCall === 'function') {
              let result = funcCall.call(overrideContext.bindingContext, topIndex, isAtBottom, isAtTop);
              if (!(result instanceof Promise)) {
                // Reset for the next time
                this._calledGetMore = false;
              } else {
                return result.then(() => {
                  // Reset for the next time
                  this._calledGetMore = false;
                });
              }
            } else {
              throw new Error(`'${scrollNextAttrName}' must be a function or evaluate to one`);
            }
          } else if (func.sourceExpression) {
            // Reset for the next time
            this._calledGetMore = false;
            return func.sourceExpression.evaluate(this.scope);
          } else {
            throw new Error(`'${scrollNextAttrName}' must be a function or evaluate to one`);
          }
          return null;
        };

        this.taskQueue.queueMicroTask(executeGetMore);
      }
    }
  }

  /**
   * @internal Set flags based on internal values of first view index, previous view index
   *
   * Determines scrolling state, scroll direction, switching scroll direction
   */
  _checkScrolling(): void {
    if (this._first > this._previousFirst && (this._bottomBufferHeight > 0 || !this.isLastIndex)) {
      if (!this._scrollingDown) {
        this._scrollingDown = true;
        this._scrollingUp = false;
        this._switchedDirection = true;
      } else {
        this._switchedDirection = false;
      }
      this._isScrolling = true;
    } else if (this._first < this._previousFirst && (this._topBufferHeight >= 0 || !this._isAtTop)) {
      if (!this._scrollingUp) {
        this._scrollingDown = false;
        this._scrollingUp = true;
        this._switchedDirection = true;
      } else {
        this._switchedDirection = false;
      }
      this._isScrolling = true;
    } else {
      this._isScrolling = false;
    }
  }

  /**@internal */
  _updateBufferElements(): void {
    this.topBufferEl.style.height = `${this._topBufferHeight}px`;
    this.bottomBufferEl.style.height = `${this._bottomBufferHeight}px`;
  }

  /**@internal*/
  _unsubscribeCollection(): void {
    let collectionObserver = this.collectionObserver;
    if (collectionObserver) {
      collectionObserver.unsubscribe(this.callContext, this);
      this.collectionObserver = this.callContext = null;
    }
  }

  /**@internal */
  _getFirstView(): IView | null {
    return this.view(0);
  }

  /**@internal */
  _getLastView(): IView | null {
    return this.view(this.viewCount() - 1);
  }

  /**
   * @internal Move views based on scrolling direction and number of views to move
   */
  _moveViews(viewsCount: number): number {
    let getNextIndex = this._scrollingDown ? $plus : $minus;
    let childrenCount = this.viewCount();
    let viewIndex = this._scrollingDown ? 0 : childrenCount - 1;
    let items = this.items;
    let currentIndex = this._scrollingDown ? this._getIndexOfLastView() + 1 : this._getIndexOfFirstView() - 1;
    let i = 0;
    let viewToMoveLimit = viewsCount - (childrenCount * 2);
    while (i < viewsCount && !this._isAtFirstOrLastIndex) {
      let view = this.view(viewIndex);
      let nextIndex = getNextIndex(currentIndex, i);
      this.isLastIndex = nextIndex > items.length - 2;
      this._isAtTop = nextIndex < 1;
      if (!(this._isAtFirstOrLastIndex && childrenCount >= items.length)) {
        if (i > viewToMoveLimit) {
          rebindAndMoveView(this, view, nextIndex, this._scrollingDown);
        }
        i++;
      }
    }
    return viewsCount - (viewsCount - i);
  }

  /**@internal */
  get _isAtFirstOrLastIndex(): boolean {
    return !this._isScrolling || this._scrollingDown ? this.isLastIndex : this._isAtTop;
  }

  /**@internal*/
  _getIndexOfLastView(): number {
    const lastView = this._getLastView();
    return lastView === null ? -1 : lastView.overrideContext.$index;
  }

  /**@internal*/
  _getLastViewItem(): IView {
    let lastView = this._getLastView();
    return lastView === null ? undefined : lastView.bindingContext[this.local];
  }

  /**@internal*/
  _getIndexOfFirstView(): number {
    let firstView = this._getFirstView();
    return firstView === null ? -1 : firstView.overrideContext.$index;
  }

  /**
   * @internal Calculate the necessary initial heights. Including:
   *
   * - item height
   * - scroll container height
   * - number of elements in view port
   * - first item index
   * - top/bottom buffers' height
   */
  _calcInitialHeights(itemsLength: number): void {
    const isSameLength = this._viewsLength > 0 && this._prevItemsCount === itemsLength;
    if (isSameLength) {
      return;
    }
    if (itemsLength < 1) {
      this._resetCalculation();
      return;
    }
    this._hasCalculatedSizes = true;
    let firstViewElement = this.view(0).lastChild as Element;
    this.itemHeight = calcOuterHeight(firstViewElement);
    if (this.itemHeight <= 0) {
      this._sizeInterval = PLATFORM.global.setInterval(() => {
        let newCalcSize = calcOuterHeight(firstViewElement);
        if (newCalcSize > 0) {
          PLATFORM.global.clearInterval(this._sizeInterval);
          this.itemsChanged();
        }
      }, 500);
      return;
    }

    this._prevItemsCount = itemsLength;
    this.scrollContainerHeight = this._fixedHeightContainer
      ? this._calcScrollHeight(this.scrollContainer)
      : document.documentElement.clientHeight;
    this.elementsInView = Math$ceil(this.scrollContainerHeight / this.itemHeight) + 1;
    const viewsCount = this._viewsLength = this.elementsInView * 2;

    // Look at top buffer height (how far we've scrolled down)
    // If top buffer height is greater than the new bottom buffer height (how far we *can* scroll down)
    //    Then set top buffer height to max it can be (bottom buffer height - views in length?) and bottom buffer height to 0

    // Calc how much buffer room to the bottom if you were at the top
    let newBottomBufferHeight = this.itemHeight * (itemsLength - viewsCount);

    // In case of small lists, ensure that we never set the buffer heights to impossible values
    if (newBottomBufferHeight < 0) {
      newBottomBufferHeight = 0;
    }

    // Use case when items are removed (we've scrolled past where we can)
    if (this._topBufferHeight >= newBottomBufferHeight) {
      this._topBufferHeight = newBottomBufferHeight;
      this._bottomBufferHeight = 0;
      this._first = itemsLength - viewsCount;
      if (this._first < 0) { // In case of small lists, ensure that we never set first to less than possible
        this._first = 0;
      }
    } else { // Use case when items are added (we are adding scrollable space to the bottom)
      // We need to re-evaluate which is the true "first". If we've added items, then the previous "first" is actually too far down the list
      this._first = this._getIndexOfFirstView();
      // appropriate buffer height for top, might be 1 too long...
      let adjustedTopBufferHeight = this._first * this.itemHeight;
      this._topBufferHeight = adjustedTopBufferHeight;
      // But what about when we've only scrolled slightly down the list? We need to readjust the top buffer height then
      this._bottomBufferHeight = newBottomBufferHeight - adjustedTopBufferHeight;
      if (this._bottomBufferHeight < 0) {
        this._bottomBufferHeight = 0;
      }
    }
    this._updateBufferElements();
  }

  /**@internal*/
  _calcScrollHeight(element: Element): number {
    let height = element.getBoundingClientRect().height;
    height -= getStyleValues(element, 'borderTopWidth', 'borderBottomWidth');
    return height;
  }

  /**
   * If repeat items is behind a binding behavior or value converter
   * the real array is "inner" part of the expression
   * which should be observed via this method
   * @internal
   */
  _observeInnerCollection(): boolean {
    let items = this._getInnerCollection();
    let strategy = this.strategyLocator.getStrategy(items);
    if (!strategy) {
      return false;
    }
    let collectionObserver = strategy.getCollectionObserver(this.observerLocator, items);
    if (!collectionObserver) {
      return false;
    }
    let context = VirtualRepeatCallContext.handleInnerCollectionMutated;
    this.collectionObserver = collectionObserver;
    this.callContext = context;
    collectionObserver.subscribe(context, this);
    return true;
  }

  /**@internal*/
  _getInnerCollection(): any {
    let expression = unwrapExpression(this.sourceExpression);
    if (!expression) {
      return null;
    }
    return expression.evaluate(this.scope, null);
  }

  /**@internal*/
  _observeCollection(): void {
    let collectionObserver = this.strategy.getCollectionObserver(this.observerLocator, this.items);
    if (collectionObserver) {
      this.callContext = VirtualRepeatCallContext.handleCollectionMutated;
      this.collectionObserver = collectionObserver;
      collectionObserver.subscribe(this.callContext, this);
    }
  }

  // @override AbstractRepeater
  // How will these behaviors need to change since we are in a virtual list instead?
  /**@override */
  viewCount() {
    return this.viewSlot.children.length;
  }

  /**@override */
  views() {
    return this.viewSlot.children;
  }

  /**@override */
  view(index: number) {
    const viewSlot = this.viewSlot;
    return index < 0 || index > viewSlot.children.length - 1 ? null : viewSlot.children[index];
  }

  /**@override */
  addView(bindingContext: any, overrideContext: OverrideContext) {
    let view = this.viewFactory.create();
    view.bind(bindingContext, overrideContext);
    this.viewSlot.add(view);
  }

  /**@override */
  insertView(index: number, bindingContext: any, overrideContext: OverrideContext) {
    let view = this.viewFactory.create();
    view.bind(bindingContext, overrideContext);
    this.viewSlot.insert(index, view);
  }

  /**@override */
  removeAllViews(returnToCache: boolean, skipAnimation: boolean) {
    return this.viewSlot.removeAll(returnToCache, skipAnimation);
  }

  /**@override */
  removeView(index: number, returnToCache: boolean, skipAnimation: boolean): IView | Promise<IView> {
    return this.viewSlot.removeAt(index, returnToCache, skipAnimation) as IView | Promise<IView>;
  }

  updateBindings(view: View) {
    let j = view.bindings.length;
    while (j--) {
      updateOneTimeBinding(view.bindings[j]);
    }
    j = view.controllers.length;
    while (j--) {
      let k = view.controllers[j].boundProperties.length;
      while (k--) {
        let binding = view.controllers[j].boundProperties[k].binding;
        updateOneTimeBinding(binding);
      }
    }
  }
}

const $minus = (index: number, i: number) => index - i;
const $plus = (index: number, i: number) => index + i;
