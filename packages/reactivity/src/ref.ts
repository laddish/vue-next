import { isTracking, trackEffects, triggerEffects } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged } from '@vue/shared'
import { isProxy, toRaw, isReactive, toReactive } from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { CollectionTypes } from './collectionHandlers'
import { createDep, Dep } from './dep'

declare const RefSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
  /**
   * @internal
   */
  _shallow?: boolean
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

/**
 * get value时收集依赖
 * @param ref
 */
export function trackRefValue(ref: RefBase<any>) {
  if (isTracking()) {
    ref = toRaw(ref)
    if (!ref.dep) {
      // 创建一个set集合 用于存放对应的依赖
      // 使用set的原因是为了可以对effect去重
      ref.dep = createDep()
    }
    if (__DEV__) {
      trackEffects(ref.dep, {
        target: ref,
        type: TrackOpTypes.GET,
        key: 'value'
      })
    } else {
      trackEffects(ref.dep)
    }
  }
}

export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  ref = toRaw(ref)
  if (ref.dep) {
    if (__DEV__) {
      triggerEffects(ref.dep, {
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: newVal
      })
    } else {
      triggerEffects(ref.dep)
    }
  }
}

export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
export function isRef(r: any): r is Ref {
  return Boolean(r && r.__v_isRef === true)
}

export function ref<T extends object>(
  value: T
): [T] extends [Ref] ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>

// value是一个普通类型
export function ref(value?: unknown) {
  // 将普通类型 变成 一个对象
  // 可以是对象 但是一般情况下 对象直接用 reactive 更合理
  // false 表示不是浅的 默认都是深的
  return createRef(value, false)
}

// ref 和 reactive 的区别
// reactive 内部采用 proxy
// ref 内部使用的是 defineProperty ?

declare const ShallowRefMarker: unique symbol

type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }

// 只做一层
export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : ShallowRef<T>
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
// 如果调用的是shallowRef 浅值为true
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}
/**
 * 创建ref
 * @param rawValue 原值
 * @param shallow 浅
 * @returns
 */
function createRef(rawValue: unknown, shallow: boolean) {
  if (isRef(rawValue)) {
    return rawValue
  }
  // 返回的是一个实例
  return new RefImpl(rawValue, shallow)
}

/**
 * RefImpl 类
 * 用的是 Object.defineProperty
 * beta之前版本
 * ref就是一个对象
 * 因为对象不方便扩展 改成了类
 */
class RefImpl<T> {
  //表示声明了 但是没有赋值
  private _value: T //保存原始值 用于get返回值
  private _rawValue: T

  public dep?: Dep = undefined
  //产生的实例会被添加只读的 __v_isRef 表示是一个ref属性
  public readonly __v_isRef = true
  /**
   *
   * @param value
   * @param _shallow
   */
  // 默认绑定 表示此属性放到了实例上 就可以直接用了
  // 声明同时赋值
  constructor(value: T, public readonly _shallow: boolean) {
    // 如果是浅的
    this._rawValue = _shallow ? value : toRaw(value)
    // 如果是浅的直接赋值 如果是深的 需要转成 reactive 的
    this._value = _shallow ? value : toReactive(value)
  }

  // 类的属性访问器
  // 转成 es5 会被编译成 defineProperty
  get value() {
    // 取值的时候 需要track 跟踪依赖
    trackRefValue(this)
    // 返回原来的值
    return this._value
  }

  set value(newVal) {
    // 更改值的时候 需要trigger 触发更新
    newVal = this._shallow ? newVal : toRaw(newVal)
    // 看一下新值和老值是否一样
    if (hasChanged(newVal, this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : toReactive(newVal)
      triggerRefValue(this, newVal)
    }
  }
}

export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

export function unref<T>(ref: T | Ref<T>): T {
  return isRef(ref) ? (ref.value as any) : ref
}

const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}

export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  // #2687: somehow using ToRef<T[K]> here turns the resulting type into
  // a union of multiple Ref<*> types instead of a single Ref<* | *> type.
  [K in keyof T]: T[K] extends Ref ? T[K] : Ref<UnwrapRef<T[K]>>
}
export function toRefs<T extends object>(object: T): ToRefs<T> {
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  // 是数组就创建一个新数组 不是就创建一个新对象
  // 数组的每一项 toRef 对象的每个值 toRef
  const ret: any = isArray(object) ? new Array(object.length) : {}
  // 循环调用toRef
  for (const key in object) {
    ret[key] = toRef(object, key)
  }
  return ret
}
// toRef的属性如果本身不是ref 就把原对象传入到这里
// 就相当于defineProperty(原对象，某个键值)
// 将 其 标记为 ref
class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true //加了个 __v_isRef 的标记

  constructor(private readonly _object: T, private readonly _key: K) {}
  // 直接获取值
  get value() {
    return this._object[this._key]
  }
  // 直接设置值
  set value(newVal) {
    this._object[this._key] = newVal
  }
}

export type ToRef<T> = [T] extends [Ref] ? T : Ref<T>

// 可以把一个对象的值转化成ref类型
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]> {
  const val = object[key]
  return isRef(val) ? val : (new ObjectRefImpl(object, key) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 *
 * Note that api-extractor somehow refuses to include `declare module`
 * augmentations in its generated d.ts, so we have to manually append them
 * to the final generated d.ts in our build process.
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V
    : // if `V` is `unknown` that means it does not extend `Ref` and is undefined
    T[K] extends Ref<infer V> | undefined
    ? unknown extends V
      ? undefined
      : V | undefined
    : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  ? T
  : T extends Array<any>
  ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
  : T extends object & { [ShallowReactiveMarker]?: never }
  ? {
      [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
    }
  : T
