import {
  // vue3的代理是懒代理
  // 对象的属性如果还是对象只有取值的时候才会去代理
  // vue2的代理 是 一上来就递归代理
  // vue3的代理是走到getter里面
  // 如果取得是对象的某个值
  // 还是一个对象
  // 当取值时会进行代理
  // 如果标记是 只读 就需要再用readonly 包起来
  // 如果不是只读 采用reactive包起来
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend, //合并对象方法 实际上就是 Object.assign
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /**
   * Object.getOwnPropertyNames(Symbol)
   * ["length", "name", "prototype", "for", "keyFor", "asyncIterator", "hasInstance", "isConcatSpreadable", "iterator", "match", "matchAll", "replace", "search", "species", "split", "toPrimitive", "toStringTag", "unscopables", "useSetter", "useSimple"]
   */
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

/**
 * 四种不同的handler对应 不同的getter方法
 * 根据不同的参数 生成不同的getter方法
 * @param isReadonly 默认false
 * @param shallow 默认false
 */
// mutableHandlers
const get = /*#__PURE__*/ createGetter()
// shallowReactiveHandlers
const shallowGet = /*#__PURE__*/ createGetter(false, true)
// readonlyHandlers
const readonlyGet = /*#__PURE__*/ createGetter(true)
// shallowReadonlyHandlers
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // 当调用 includes indexOf lastIndexOf 方法时
  // 对数组的每一项进行依赖收集
  // 并对数组的每一项调用原有方法

  // instrument identity-sensitive Array methods to account for possible reactive
  // values 方法劫持 重写原有方法 并且调用原有方法
  // 可以添加自己的逻辑
  // proxy([a,b,c]).includes(x)
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 拿到原来的数组
      const arr = toRaw(this) as any
      // 循环里面的每一项进行依赖收集
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // 对会修改 数组 length 属性的方法
  // 进行劫持 防止 length 属性 被 跟踪
  // 跟踪 length 属性 在一些情况下会陷入死循环
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // https://github.com/vuejs/vue-next/pull/2138
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 可以控制是否依赖收集
      // 暂停依赖收集
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}
// 如果对象被代理过 取值就会执行get方法

/**
 * 根据不同参数 创建一个getter方法
 * get baseHandler
 * 取值的时候 会触发get
 * 会对数组类型进行单独处理
 * 对ref进行处理
 * @param isReadonly
 * @param shallow
 * @returns
 */
function createGetter(isReadonly = false, shallow = false) {
  // 进行依赖收集
  return function get(
    target: Target, //目标
    key: string | symbol, //键
    receiver: object
  ) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      // 用来判断这个对象时 reactive 还是 readonly
      // 不是 readonly 就是 reactive
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // 获取 IS_READONLY 属性 是不是只读
      return isReadonly
    } else if (
      // 把一个代理对象的原始对象给返回
      // 可以使用 toRaw 方法获取被代理过对象对应的原值
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)
    // 如果是数组 对 includes indexOf lastIndexOf 方法进行处理
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    // 使用 Reflect.get(target, key, receiver) 来取值 相当于 target[key]
    const res = Reflect.get(target, key, receiver)

    if (
      // 如果key是 Symbol 内置key 或者是 原型链 查找到的 直接返回
      // 不需要收集他们的依赖
      isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)
    ) {
      return res
    }

    if (!isReadonly) {
      // 需要收集依赖
      // 当 effect 里面初次获取值的时候 对应值的getter会走到这里
      // 如果传入的 isReadonly 不是只读的 就说明需要收集依赖
      // 如果不是readonly 那么就依赖收集
      track(target, TrackOpTypes.GET, key)
    }

    if (shallow) {
      // 如果是浅的 就直接返回
      // 就不需要被代理
      return res
    }

    if (isRef(res)) {
      // 如果reactive包裹的是ref
      // 则自动解包 res.value
      // ref unwrapping - does not apply for Array + integer key.
      // 不适用于 数组 和 数字下标的情况
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    if (isObject(res)) {
      // 如果取的对象的属性还是一个对象
      // 有可能递归
      // 如果传入的是只读 就用readonly包裹起来
      // 不是只读 就用reactive包裹起来
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}
// 创建set方法 set值的时候需要执行Map里面的effect
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

/**
 * 设置值的时候
 * 会触发setter
 * 对新增和修改做不同的处理
 * @param shallow
 * @returns
 */
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol, //原对象的某个属性
    value: unknown, //新值
    receiver: object //代理对象
  ): boolean {
    // 先拿到老的值
    let oldValue = (target as any)[key]
    if (!shallow) {
      // 对象被深层代理了 reactive({r:1})
      // 改值的时候 将一个代理的对象赋给旧值
      // proxy.r = reactive({a:1})
      // 如果设置的值是reactive过的 会被转化为普通对象
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        // 旧的是ref 新的不是ref 则会给旧的ref赋值
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }
    // 判断是新增还是修改
    const hadKey =
      // 判断数组 和是否是 整型key
      isArray(target) && isIntegerKey(key)
      // 看一下改的值是不是长度以内 是的话就说明已有
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 使用Reflect.set(target, key, value, receiver)
    // 相当于 target[key] = value
    // 具备了 返回值
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 如果 目标 是 原值 原型链上的方法
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 新增
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 修改
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

/**
 * mutableHandlers
 */
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}
/**
 * readonlyHandlers
 * set 和 deleteProperty 无意义
 */
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      // 开发模式下 警告
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

/**
 * shallowReactiveHandlers
 * 继承 extend mutableHandlers
 */
export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

/**
 * shallowReadonlyHandlers
 * 继承 extend readonlyHandlers
 */
// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
