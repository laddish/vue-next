// 为什么能识别出来 @
import { isObject, toRawType, def } from '@vue/shared'

// 在 baseHandlers 中不同的处理函数
import {
  mutableHandlers, //reactive
  readonlyHandlers, //readonly
  shallowReactiveHandlers, //shallowReactive
  shallowReadonlyHandlers //shallowReadonly
} from './baseHandlers'

import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from './collectionHandlers'

import { UnwrapRefSimple, Ref } from './ref'

export const enum ReactiveFlags {
  SKIP = '__v_skip', //跳过标记
  IS_REACTIVE = '__v_isReactive', //响应式标记
  IS_READONLY = '__v_isReadonly', //只读标记
  RAW = '__v_raw' //原对象标记
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.RAW]?: any
}

// 四种类型 的 映射表  创建reative的时候 传入对应的映射表
export const reactiveMap = new WeakMap<Target, any>()
export const shallowReactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()
export const shallowReadonlyMap = new WeakMap<Target, any>()

const enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2
}

function targetTypeMap(rawType: string) {
  // 如果是 对象或者数组 那么是 COMMON 普通类型
  // 如果是 Map Set WeakMap WeakSet 类型那么是 COLLECTION 集合类型
  // 其余情况为 INVALID 类型
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  // 如果一个值有 SKIP 则不可被代理 如果不可被扩展 则不可被代理
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

// only unwrap nested ref
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

/**
 * Creates a reactive copy of the original object.
 * 创建一个原对象的响应式拷贝
 * The reactive conversion is "deep"—it affects all nested properties. In the
 * ES2015 Proxy based implementation, the returned proxy is **not** equal to the
 * original object. It is recommended to work exclusively with the reactive
 * proxy and avoid relying on the original object.
 *
 * A reactive object also automatically unwraps refs contained in it, so you
 * don't need to use `.value` when accessing and mutating their value:
 *
 * ```js
 * const count = ref(0)
 * const obj = reactive({
 *   count
 * })
 *
 * obj.count++
 * obj.count // -> 1
 * count.value // -> 1
 * ```
 */
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  // 如果这个对象已经被 readonly 代理过了，则直接返回
  // 被 readonly 代理过就会添加 proxy，取值时会走 get 方法 所以直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  return createReactiveObject(
    target, // (arr obj)  (map set)
    false, // 不是只读
    mutableHandlers, //new Proxy 对应的 handler
    mutableCollectionHandlers, //collection Handlers
    reactiveMap
  )
}

export declare const ShallowReactiveMarker: unique symbol

export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

/**
 * Return a shallowly-reactive copy of the original object, where only the root
 * level properties are reactive. It also does not auto-unwrap refs (even at the
 * root level).
 */
export function shallowReactive<T extends object>(
  target: T
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false, // 不是只读
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends WeakMap<infer K, infer V>
  ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends Set<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends ReadonlySet<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends WeakSet<infer U>
  ? WeakSet<DeepReadonly<U>>
  : T extends Promise<infer U>
  ? Promise<DeepReadonly<U>>
  : T extends Ref<infer U>
  ? Ref<DeepReadonly<U>>
  : T extends {}
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : Readonly<T>

/**
 * Creates a readonly copy of the original object. Note the returned copy is not
 * made reactive, but `readonly` can be called on an already reactive object.
 */
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true, // 只读
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  )
}

/**
 * Returns a reactive-copy of the original object, where only the root level
 * properties are readonly, and does NOT unwrap refs nor recursively convert
 * returned properties.
 * This is used for creating the props proxy object for stateful components.
 */
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true, // 不是只读
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  )
}
/**
 * 流程梳理：
 * 1.判断是否是对象；
 * 2.重复代理情况；（需要做一个映射表，来查看是否被代理过）
 *
 * 3.对不同类型进行proxy； get/set
 * 4.做缓存；
 * @param target 原对象
 * @param isReadonly 是否只读
 * @param baseHandlers 处理函数
 * @param collectionHandlers 集合处理函数
 * @param proxyMap 每种类型不同的映射表
 * @returns
 */
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>
) {
  //reactive 只接受对象 不是对象不拦截 直接返回
  if (!isObject(target)) {
    if (__DEV__) {
      // 开发模式下 警告
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    // 不是对象直接返回
    return target
  }
  // target is already a Proxy, return it.
  // 目标已经被代理 直接返回
  // exception: calling readonly() on a reactive object
  // 如果被 reactive 处理过的对象 还可以继续被 readonly 处理
  // readonly(reactive(obj))
  if (
    // 可以使用toRaw方法获取被代理过对象对应的原值
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  // 如果已经被代理了就返回 说明一个对象不能被重复代理
  // 在 缓存 中取出这个对象是否存在代理
  const existingProxy = proxyMap.get(target)
  // 如果已经被代理了 直接返回即可
  if (existingProxy) {
    return existingProxy
  }
  // only a whitelist of value types can be observed.
  // 只有 白名单类型 才能被代理 会看一看能不能被代理
  // 如果被 markRaw 过，就无法被代理
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    // 不可扩展则直接返回
    return target
  }

  // 最核心的代码 创建proxy 传入 原对象和handlers
  // 对 集合的处理（collectionHandlers） 和 普通的对象（baseHandlers） 略有不同
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  // 最终把 对象 和 代理 放到 WeakMap 缓存起来
  proxyMap.set(target, proxy)
  return proxy
}

export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

export function toRaw<T>(observed: T): T {
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

export function markRaw<T extends object>(value: T): T {
  def(value, ReactiveFlags.SKIP, true)
  return value
}
// 传入的值 如果是对象 就转换成 reactive
// 如果不是对象 就返回值
export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

export const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value
