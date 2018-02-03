module.exports = {
  /**
   * Application configuration section
   * http://pm2.keymetrics.io/docs/usage/application-declaration/
   */
  apps: [
    // First application
    {
      name: "rpicalarm",
      cwd: "/var/www/rpicalarm",
      script: "dist/app.js",
      args: "-c etc/antibes-rpicalarm.conf",
      out_file: "/var/log/rpicalarm/rpicalarm.log",
      err_file: "/var/log/rpicalarm/rpicalarm.log",
      pid_file: "/var/run/user/1000/rpicalarm/rpicalarm.pid",
      combine_logs: true,
      env: {},
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]

  /**
   * Deployment section
   * http://pm2.keymetrics.io/docs/usage/deployment/
   */
  // deploy: {
  //   production: {
  //     user: 'node',
  //     host: '212.83.163.1',
  //     ref: 'origin/master',
  //     repo: 'git@github.com:repo.git',
  //     path: '/var/www/production',
  //     'post-deploy': 'npm install && pm2 startOrRestart ecosystem.json --env production'
  //   },
  //   dev: {
  //     user: 'node',
  //     host: '212.83.163.1',
  //     ref: 'origin/master',
  //     repo: 'git@github.com:repo.git',
  //     path: '/var/www/development',
  //     'post-deploy': 'npm install && pm2 startOrRestart ecosystem.json --env dev',
  //     env: {
  //       NODE_ENV: 'dev'
  //     }
  //   }
  // }
};
