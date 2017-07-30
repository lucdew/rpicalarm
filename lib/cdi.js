const logger = require('log4js').getLogger('cdi')

function getGraphAsText (graph) {
  return graph.map(level => level.map(dep => dep.$name).join(',')).join(' --> ')
}

function buildGraph (ctx) {
  const levels = []
  const depLevels = {}

  function pushAt (idx, dep) {
    let level = levels[idx]
    if (!level) {
      level = []
      levels[idx] = level
    }
    level.push(dep)
    depLevels[dep.$name] = idx
  }

  function insertDep (dep, levelIdx) {
    const existingLevelIdx = depLevels[dep.$name]
    if (isNaN(existingLevelIdx)) {
      pushAt(levelIdx, dep)
    } else if (existingLevelIdx < levelIdx) {
      const idx = levels[existingLevelIdx].findIndex(aDep => aDep.$name === dep.$name)
      levels[existingLevelIdx].splice(idx, 1)
      pushAt(levelIdx, dep)
    }
  }

  function visitDep (depName, visitedDeps, parents) {
    if (!visitedDeps) {
      if (!isNaN(depLevels[depName])) {
        // already treated
        return
      }
      visitedDeps = []
    }
    if (!parents) {
      parents = []
    }
    const dep = ctx[depName]
    dep.$name = depName
    if (!dep) {
      throw new Error('Unknown depency ' + depName)
    }
    if (visitedDeps.includes(depName)) {
      throw new Error('Cyclic dependency for ' + depName)
    }
    visitedDeps.push(depName)
    if (dep.$inject && dep.$inject instanceof Array && dep.$inject.length > 0) {
      for (const childDepName of dep.$inject) {
        const someParents = parents.slice(0)
        someParents.unshift(dep)
        visitDep(childDepName, visitedDeps.slice(), someParents)
      }
    }
    let aDep = dep
    insertDep(aDep, 0)
    for (const parentDep of parents) {
      insertDep(parentDep, depLevels[aDep.$name] + 1)
      aDep = parentDep
    }
  }

  for (const depName in ctx) {
    visitDep(depName)
  }

  return levels
}

function autoDiscoverAgents (cfg, ctx) {
  for (const agentName in cfg.agents) {
    const agentConstructor = require('./agent/' + agentName)
    ctx[agentName] = agentConstructor
  }
}

function buildAppCtx (cfg, ctx, {
  autoDiscovery
}) {
  if (autoDiscovery === true) {
    autoDiscoverAgents(cfg, ctx)
  }
  const instanceCtx = {}
  const graph = buildGraph(ctx)
  if (logger.isDebugEnabled()) {
    logger.debug('Dependency graph %s', getGraphAsText(graph))
  }

  for (const level of graph) {
    level.forEach(Dep => {
      const args = [null, cfg[Dep.$name] || cfg.agents[Dep.$name]]
      if (Dep.$inject) { // TODO: check is array type
        const injectInstances = {}
        for (const ij of Dep.$inject) {
          injectInstances[ij] = instanceCtx[ij]
        }
        args.push(injectInstances)
      }
      const [, ...remArgs] = args

      if (Dep.name && Dep.name.length > 0 && Dep.name[0] && /^[A-Z]*$/.test(Dep.name[0])) { // only works for ascii
        logger.debug('Instantiating context factory [%s], with function [%s] and args %j', Dep.$name, Dep.name, remArgs)
        instanceCtx[Dep.$name] = new (Function.prototype.bind.apply(Dep, args))()
      } else {
        logger.debug('Executing context factory [%s] with args %j', Dep.$name, remArgs)
        instanceCtx[Dep.$name] = Dep.apply(null, args)
      }

      instanceCtx[Dep.$name].supports = Dep.supports
      instanceCtx[Dep.$name].$name = Dep.$name
    })
  }
  return {
    getByName (name) {
      return instanceCtx[name]
    },
    getBySupport (...supports) {
      const beans = []
      for (const beanName in instanceCtx) {
        if (instanceCtx[beanName].supports) {
          for (const support of instanceCtx[beanName].supports) {
            if (supports.includes(support)) {
              beans.push(instanceCtx[beanName])
              break
            }
          }
        }
      }
      return beans
    }

  }
}

module.exports.buildGraph = buildGraph
module.exports.buildAppCtx = buildAppCtx

module.exports.autoDiscoverAgents = autoDiscoverAgents
