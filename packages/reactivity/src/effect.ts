import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
// 让某个对象中的某个属性 收集 他对应的依赖 effect函数
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels op recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}
// 创建effect栈 用来模拟函数执行栈 执行完出栈
// effect 用来保证变量和effect对应顺序正确
const effectStack: ReactiveEffect[] = []

// 当前正在执行的effect
// 全局变量 当前活跃的effect
// 用于track的时候能获取到
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  active = true // 是否激活
  deps: Dep[] = [] // effect对应的属性
  // effect(()=>state.name+state.age)

  // can be attached after creation
  computed?: boolean
  allowRecurse?: boolean // 运行effect重复执行
  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T, //this.fn()
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope | null // 作用域
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    // active默认为true
    if (!this.active) {
      // 如果不是active的
      return this.fn()
    }
    // 保证effect没有加入到 effectStack 中
    // 如果栈里面已经有了这个effect 就不再往里面放了
    // 有的话就不应该再次重新执行了
    // 防止死循环 无限循环
    if (!effectStack.includes(this)) {
      // 栈里面没有
      // 函数执行的时候有可能会发生异常 所以要加try
      try {
        effectStack.push((activeEffect = this))
        // 启用依赖收集
        enableTracking()

        trackOpBit = 1 << ++effectTrackDepth

        if (effectTrackDepth <= maxMarkerBits) {
          initDepMarkers(this)
        } else {
          // 清理 重新收集依赖
          cleanupEffect(this)
        }
        // 返回结果
        return this.fn() //函数执行的时候会取值 会执行get方法
      } finally {
        // 不用catch因为不需要管错误
        if (effectTrackDepth <= maxMarkerBits) {
          finalizeDepMarkers(this)
        }

        trackOpBit = 1 << --effectTrackDepth

        resetTracking()
        effectStack.pop() //函数执行完出栈
        const n = effectStack.length
        // 弹出刚执行完的 effect
        // 此时活跃的 effect 应该是此时栈里面的最后一个
        // 保证activeEffect 永远是当前正确的effect
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

// ReactiveEffectOptions 的接口限制
// lazy 选传
export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

// 我要让这个effect编程响应式的effect
// 可以做到数据变化就执行
// 响应式的effect默认会先执行一次
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    // 已经是effect 再被effect 取出函数 重新创建effect
    fn = (fn as ReactiveEffectRunner).effect.fn
  }
  // 创建响应式effect
  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 如果没有传options 或者传入的options.lazy为false 就先执行
  if (!options || !options.lazy) {
    // 默认就先执行一次 立即执行
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 只有取值才会走getter 赋值不会走 getter
 * 需要让target和key能找到触发getter的effect
 * vue2/vue3 中使用了全局变量 activeEffect
 * 但存在一个严重问题:
 *
 * 函数的调用栈 入栈 出栈
 * effect(()=>{ //effect1 入栈
 *  state.name; -> effect1
 *  effect(()=>{ //effect2 入栈
 *    state.age -> effect2
 *  }) //effect2 出栈 并且让activeEffect取effect栈的最后一个
 *  state.address; -> effect1
 * })
 * 为什么要用到栈？
 * 要保证收集的 effect 是正确的
 *
 * 防止死循环
 *
 * effect(()=>{
 *  state.xxx++
 * })
 * 解决方法
 * effect入栈的时候需要看一看这个effect是否已经入栈
 *
 * @param target 目标
 * @param type 类型
 * @param key
 * @returns
 */
//让某个对象中的属性 收集他对应的 effect 函数
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 判断是否在effect中取的值 也就是看activeEffect是不是undefined
  if (!isTracking()) {
    return
  }
  // 从 WeakMap 中 取 target 对应的 Map
  let depsMap = targetMap.get(target)
  // 第一次肯定没有
  // 就需要赋值
  if (!depsMap) {
    // 创建 depsMap
    // 使用 WeakMap
    // key是个对象
    // targetMap(WeakMap) -> target -> depsMap(Map)
    //             ( key -> dep )
    // WeakMap的key          Map的key  Set
    // {name:"zf",age:12} -> name -> [effect,effect]
    targetMap.set(target, (depsMap = new Map()))
  }
  // 有没有对应的依赖收集
  let dep = depsMap.get(key)
  if (!dep) {
    // 如果没有 就new Set
    depsMap.set(key, (dep = createDep()))
  }

  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined

  trackEffects(dep, eventInfo)
  console.log('targetMap')
  console.log(targetMap)
}

export function isTracking() {
  // 是否要收集依赖 如果此时activeEffect有值
  // 说明是在effect中取的值 需要收集依赖effect
  return shouldTrack && activeEffect !== undefined
}

//
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    // set 添加一个activeEffect
    // 必须用set 否则会重复
    // 比如:
    // effect(()=>{
    //  state.name
    //  state.name
    //  state.name
    // })
    // 上面这种情况有可能会收集三次
    // vue2中的 dep 和 watcher
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

// 触发 修改值
/**
 * 让对应的effect执行
 * @param target 目标
 * @param type 类型 SET = 'set',ADD = 'add',DELETE = 'delete',CLEAR = 'clear'
 * @param key 键
 * @param newValue 新值
 * @param oldValue 旧值
 * @param oldTarget 旧目标
 * @returns
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取targetMap中对象的depsMap
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // 如果这个属性没有收集过effect 那不需要做任何操作
    // never been tracked
    return
  }
  // deps 为 空数组
  // 要将所有要执行的effect 全部存到一个新的集合中 
  // 最终一起执行
  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // 清空
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 看修改的是不是数组的长度length
    // 数组设置 length 属性
    // 如果对应的长度 有依赖收集需要更新
    depsMap.forEach((dep, key) => {
      // 里面收集的key 可能是数字下标
      if (key === 'length' || key >= (newValue as number)) {
        // 如果更改的长度 小于收集的索引 比如把 length 改小
        // 那么这个索引 也需要触发effect 重新执行
        deps.push(dep)
      }
    })
  } else {

    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // 根据不同 type 来执行
    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          // 不是数组
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 数组添加索引新元素 length属性改变 触发索引更新
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    // 这里对需要对收集的 effects 进行去重
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

// 批量处理 effects 批量执行 
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        effect.run()
      }
    }
  }
}
