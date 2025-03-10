/******************************************************************************\
 * Main entrypoint for GitHib Action. Fetches information regarding the       *
 * currently running Workflow and it's Jobs. Sends individual job status and  *
 * workflow status as a formatted notification to the Teams Webhhok URL set   *
 * in the environment variables.                                              *
 *                                                                            *
 * Org: Gamesight <https://gamesight.io>                                      *
 * Author: Anthony Kinson <anthony@gamesight.io>                              *
 * Repository: https://github.com/Gamesight/slack-workflow-status             *
 * License: MIT                                                               *
 * Copyright (c) 2020 Gamesight, Inc                                          *
\******************************************************************************/

import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
import {IncomingWebhook} from 'ms-teams-webhook'

// HACK: https://github.com/octokit/types.ts/issues/205
interface PullRequest {
  url: string
  id: number
  number: number
  head: {
    ref: string
    sha: string
    repo: {
      id: number
      url: string
      name: string
    }
  }
  base: {
    ref: string
    sha: string
    repo: {
      id: number
      url: string
      name: string
    }
  }
}

type IncludeJobs = 'true' | 'false' | 'on-failure'

process.on('unhandledRejection', handleError)
main().catch(handleError) // eslint-disable-line github/no-then

// Action entrypoint
async function main(): Promise<void> {
  // Collect Action Inputs
  const webhook_url = core.getInput('teams_webhook_url', {
    required: true
  })
  const github_token = core.getInput('repo_token', {required: true})
  const jobs_to_fetch = core.getInput("jobs_to_fetch", {required: true})
  const include_jobs = core.getInput('include_jobs', {
    required: true
  }) as IncludeJobs
  const include_commit_message =
    core.getInput('include_commit_message', {
      required: true
    }) === 'true'
  //const slack_icon = core.getInput('icon_url') // see what to do here
  //const slack_emoji = core.getInput('icon_emoji')  // see what to do here // https://www.webfx.com/tools/emoji-cheat-sheet/
  // Force as secret, forces *** when trying to print or log values
  core.setSecret(github_token)
  core.setSecret(webhook_url)
  // Auth github with octokit module
  const octokit = getOctokit(github_token)
  // Fetch workflow run data
  const {data: workflow_run} = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId
  })

  // Fetch workflow job information
  const {data: jobs_response} = await octokit.actions.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId,
    per_page: parseInt(jobs_to_fetch, 30),
  })

  const completed_jobs = jobs_response.jobs.filter(
    (job: any) => job.status === 'completed'
  )

  // Configure slack attachment styling
  let workflow_color // can be good, danger, warning or a HEX colour (#00FF00)
  let workflow_msg

  // TODO: look at what data is proccessed here and do the same for teams
  let job_fields: any[]

  if (
    completed_jobs.every((job: any) => ['success', 'skipped'].includes(job.conclusion))
  ) {
    workflow_color = 'good'
    workflow_msg = 'Success:'
    if (include_jobs === 'on-failure') {
      job_fields = []
    }
  } else if (completed_jobs.some((job : any) => job.conclusion === 'cancelled')) {
    workflow_color = 'warning'
    workflow_msg = 'Cancelled:'
    if (include_jobs === 'on-failure') {
      job_fields = []
    }
  } else {
    // (jobs_response.jobs.some(job => job.conclusion === 'failed')
    workflow_color = 'danger'
    workflow_msg = 'Failed:'
  }

  if (include_jobs === 'false') {
    job_fields = []
  }

  // Build Job Data Fields
  job_fields ??= completed_jobs.map((job : any) => {
    let job_status_icon

    switch (job.conclusion) {
      case 'success':
        job_status_icon = '✓'
        break
      case 'cancelled':
      case 'skipped':
        job_status_icon = '⃠'
        break
      default:
        // case 'failure'
        job_status_icon = '✗'
    }

    const job_duration = compute_duration({
      start: new Date(job.started_at),
      end: new Date(job.completed_at)
    })

    return {
      type: "TableCell",
      items: [
        {
            "type": "TextBlock",
            "text": `${job_status_icon} [${job.name}](${job.html_url}) \`${job_duration}\``,
            "wrap": true
        }
      ]
    }
  })

  // Payload Formatting Shortcuts
  const workflow_duration = compute_duration({
    start: new Date(workflow_run.created_at),
    end: new Date(workflow_run.updated_at)
  });
  const repo_url = `[${workflow_run.repository.full_name}](${workflow_run.repository.html_url})`;
  const branch_url = `[${workflow_run.head_branch}](${workflow_run.repository.html_url}/tree/${workflow_run.head_branch})`;
  const workflow_run_url = `[${workflow_run.run_number}](${workflow_run.html_url})`;
  // Example: Success: AnthonyKinson's `push` on `master` for pull_request
  let status_string = `${workflow_msg} ${context.actor}'s \`${context.eventName}\` on \`${branch_url}\``;
  // Example: Workflow: My Workflow #14 completed in `1m 30s`
  const details_string = `Workflow: ${context.workflow} ${workflow_run_url} completed in \`${workflow_duration}\``;

  // Build Pull Request string if required
  const pull_requests = (workflow_run.pull_requests as PullRequest[])
    .filter(
      pull_request =>
        pull_request.base.repo.url === workflow_run.repository.url // exclude PRs from external repositories
    )
    .map(
      pull_request =>
        `<${workflow_run.repository.html_url}/pull/${pull_request.number}|#${pull_request.number}> from \`${pull_request.head.ref}\` to \`${pull_request.base.ref}\``
    )
    .join(', ');

  if (pull_requests !== '') {
    status_string = `${workflow_msg} ${context.actor}'s \`pull_request\` ${pull_requests}`;
  }

  const commit_message = `Commit: ${workflow_run.head_commit?.message}`;

  const msteams = new MSTeams();
  await msteams.notify(webhook_url, msteams.generatePayload(status_string, details_string, repo_url, job_fields, include_commit_message, commit_message));
  core.info('Sent message to Microsoft Teams');
}


class MSTeams {
  /**
   * Generate msteams payload
   * @return
   */
  async generatePayload(
    status_string: string,
    details_string: string,
    repo_url: string,
    job_fields: any,
    include_commit_message: boolean,
    commit_message: any
  ) {
    const headerTitle = {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: [status_string]
        .join('\n'),
      style: 'heading',
      wrap: true
    };
    const detailLog = [
      {
        type: 'TextBlock',
        weight: 'lighter',
        text: [details_string]
          .concat(include_commit_message ? [commit_message] : [])
          .join('\n'),
        wrap: true
      }
    ];
    const repositoryLink = [
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            items: [
              {
                type: 'Image',
                style: 'person',
                url: 'https://github.githubassets.com/favicon.ico',
                altText: 'github',
                size: 'small'
              }
            ],
            width: 'auto'
          },
          {
            type: 'Column',
            items: [
              {
                type: 'TextBlock',
                size: 'Medium',
                weight: 'lighter',
                text: repo_url,
              }
            ],
            width: 'stretch'
          }
        ]
      }
    ];
    let jobsRows = [];
    for (let i = 0; i < job_fields.length; i++) {
      if (i % 3 === 0) {
        let rowCells = [];
        if (i+2 < job_fields.length) {
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i]
            }
          );
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i+1]
            }
          );
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i+2]
            }
          );
        }
        else if (i+1 < job_fields.length) {
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i]
            }
          );
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i+1]
            }
          );
        }
        else {
          rowCells.push(
            {
              type: 'TableCell',
              items: job_fields[i]
            }
          );
        }
        
        jobsRows.push({
          type: 'TableRow',
          cells: rowCells,
          style: 'default'
        });
      }
    }
    const jobTable = {
      type: "Table",
      columns: [{
          width: 1
        },{
          width: 1
        },{
          width: 1
        }
      ],
      rows: jobsRows,
      showGridLines: false
    }

    return {
      'type': 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          body: [
            headerTitle,
            ...detailLog,
            jobTable,
            repositoryLink
          ],
          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.5',
          msteams: {  
            entities: [{}]
          }
        }
      }]
    };
  }

  /**
   * Notify information about github actions to MSTeams
   * @param any url
   * @param  any payload
   * @returns {Promise} result
   */
  async notify(url: any, payload: any) {
    const client = new IncomingWebhook(url);
    const response = await client.sendRawAdaptiveCard(payload);
    core.info(`Generated payload for Microsoft Teams:\n${JSON.stringify(payload, null, 2)}`);
    if (response.status !== 202) {
      throw new Error('Failed to send notification to Microsoft Teams.\n' + 'Response:\n' + JSON.stringify(response, null, 2));
    }
  }
}

// Converts start and end dates into a duration string
function compute_duration({start, end}: {start: Date; end: Date}): string {
  // FIXME: https://github.com/microsoft/TypeScript/issues/2361
  const duration = end.valueOf() - start.valueOf()
  let delta = duration / 1000
  const days = Math.floor(delta / 86400)
  delta -= days * 86400
  const hours = Math.floor(delta / 3600) % 24
  delta -= hours * 3600
  const minutes = Math.floor(delta / 60) % 60
  delta -= minutes * 60
  const seconds = Math.floor(delta % 60)
  // Format duration sections
  const format_duration = (
    value: number,
    text: string,
    hide_on_zero: boolean
  ): string => (value <= 0 && hide_on_zero ? '' : `${value}${text} `)

  return (
    format_duration(days, 'd', true) +
    format_duration(hours, 'h', true) +
    format_duration(minutes, 'm', true) +
    format_duration(seconds, 's', false).trim()
  )
}

function handleError(err: Error): void {
  core.error(err)
  if (err && err.message) {
    core.setFailed(err.message)
  } else {
    core.setFailed(`Unhandled Error: ${err}`)
  }
}
