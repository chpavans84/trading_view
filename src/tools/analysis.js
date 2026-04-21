import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as chartCore from '../core/chart.js';
import * as dataCore from '../core/data.js';
import * as moomooCore from '../core/moomoo-tcp.js';

export function registerAnalysisTools(server) {
  server.tool(
    'portfolio_chart_snapshot',
    'Combined snapshot: reads the current TradingView chart (symbol, price, indicators, key levels) AND your Moomoo portfolio (positions in this symbol, account balance). Use this whenever the user asks "what\'s on my chart", "do I have a position in X", "analyze my chart", or any question combining chart data with their account.',
    {
      include_screenshot: z.boolean().optional().describe('Also capture a chart screenshot (default: false)'),
      study_filter: z.string().optional().describe('Filter pine indicator data to a specific indicator by name substring'),
    },
    async ({ include_screenshot, study_filter } = {}) => {
      const result = {};

      // Fetch TradingView and Moomoo data in parallel
      const [chartState, quoteData, studyValues, pineLines, pineLabels, portfolioData, fundsData] = await Promise.allSettled([
        chartCore.getState(),
        dataCore.getQuote(),
        dataCore.getStudyValues(),
        dataCore.getPineLines({ study_filter }),
        dataCore.getPineLabels({ study_filter }),
        moomooCore.getPositions(),
        moomooCore.getFunds(),
      ]);

      // Chart state
      if (chartState.status === 'fulfilled') {
        result.chart = chartState.value;
      } else {
        result.chart = { success: false, error: chartState.reason?.message || 'TradingView not connected', hint: 'Make sure TradingView Desktop is running with CDP on port 9222' };
      }

      // Quote
      if (quoteData.status === 'fulfilled') {
        result.quote = quoteData.value;
      } else {
        result.quote = { success: false, error: quoteData.reason?.message };
      }

      // Indicators
      if (studyValues.status === 'fulfilled') {
        result.indicators = studyValues.value;
      } else {
        result.indicators = { success: false, error: studyValues.reason?.message };
      }

      // Key price levels from custom Pine indicators
      if (pineLines.status === 'fulfilled') {
        result.pine_levels = pineLines.value;
      } else {
        result.pine_levels = { success: false, error: pineLines.reason?.message };
      }

      if (pineLabels.status === 'fulfilled') {
        result.pine_labels = pineLabels.value;
      } else {
        result.pine_labels = { success: false, error: pineLabels.reason?.message };
      }

      // Moomoo portfolio
      const symbol = result.chart?.symbol || '';
      const bareSymbol = symbol.replace(/^[^:]+:/, '').replace(/\d+!$/, ''); // strip exchange prefix and futures suffix

      if (portfolioData.status === 'fulfilled' && portfolioData.value?.positions) {
        const allPositions = portfolioData.value.positions;
        // Find position matching the current chart symbol
        const matchingPosition = allPositions.find(p =>
          p.symbol === symbol ||
          p.symbol === bareSymbol ||
          (bareSymbol && p.symbol.includes(bareSymbol))
        );
        result.portfolio = {
          success: true,
          current_symbol: symbol,
          position_in_symbol: matchingPosition || null,
          has_position: !!matchingPosition,
          all_positions: allPositions,
          total_positions: allPositions.length,
        };
      } else {
        result.portfolio = {
          success: false,
          error: portfolioData.reason?.message || portfolioData.value?.error || 'Could not read portfolio',
          hint: 'Make sure moomoo OpenD is running on port 11111',
        };
      }

      if (fundsData.status === 'fulfilled') {
        result.account = fundsData.value;
      } else {
        result.account = { success: false, error: fundsData.reason?.message || 'Could not read account funds' };
      }

      return jsonResult(result);
    }
  );
}
