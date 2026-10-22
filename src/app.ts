import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Get,
  HttpException,
  Module,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  type ExceptionFilter,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { Auth, OperatorGuard, type OperatorRequest } from "./auth.js";
import { pool } from "./db.js";
import { DomainError } from "./model.js";
import { Tally } from "./service.js";
class Metrics {
  requests = 0;
  errors = 0;
  elapsed = 0;
  render(): string {
    return `tally_requests_total ${this.requests}\ntally_errors_total ${this.errors}\ntally_http_duration_seconds_sum ${this.elapsed / 1000}\ntally_http_duration_seconds_count ${this.requests}\n`;
  }
}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp(),
      req = http.getRequest<OperatorRequest>(),
      res = http.getResponse<Response>();
    let status = 503,
      code = "service_unavailable";
    if (error instanceof DomainError) {
      status = error.status;
      code = error.code;
    } else if (error instanceof z.ZodError) {
      status = 422;
      code = "invalid_input";
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 404 ? "not_found" : "request_rejected";
    }
    console.error(
      JSON.stringify({
        event: "request_rejected",
        trace_id: req.traceId,
        status,
        code,
      }),
    );
    res.status(status).json({ error: code, trace_id: req.traceId });
  }
}
@Controller()
class PublicController {
  constructor(
    private readonly t: Tally,
    private readonly auth: Auth,
  ) {}
  @Get("/health") async health() {
    await this.t.db.query("SELECT 1");
    return { status: "ok", synthetic_only: true };
  }
  @Post("/api/login") login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(body, res);
  }
}
@Controller("/api")
@UseGuards(OperatorGuard)
class ApiController {
  constructor(
    private readonly t: Tally,
    private readonly auth: Auth,
  ) {}
  @Get("/state") state() {
    return this.t.state();
  }
  @Get("/session") session(@Req() req: OperatorRequest) {
    return req.operator;
  }
  @Post("/logout") logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.logout(req, res);
  }
  @Post("/accounts") account(@Body() input: unknown) {
    return this.t.account(input);
  }
  @Post("/ledger/post") post(@Body() input: unknown) {
    return this.t.post(input);
  }
  @Post("/ledger/replay") replay() {
    return this.t.rebuild();
  }
  @Post("/ledger/rebuild") rebuild() {
    return this.t.rebuild(true);
  }
  @Post("/rules") rules(@Body() input: unknown) {
    return this.t.publishRule(input);
  }
  @Post("/decisions") decide(@Body() input: unknown) {
    return this.t.evaluate(input);
  }
  @Post("/decisions/replay") replayDecisions() {
    return this.t.replayDecisions();
  }
  @Post("/catalogs") catalog(@Body() input: unknown) {
    return this.t.publishCatalog(input);
  }
  @Post("/enrich") enrich(@Body() input: unknown) {
    return this.t.enrich(input);
  }
  @Post("/reconcile") reconcile(@Body() input: unknown) {
    return this.t.reconciliation(input);
  }
  @Post("/reconcile/resolve") review(@Body() input: unknown) {
    return this.t.resolve(input);
  }
  @Post("/feeds") feed(@Body() input: unknown) {
    return this.t.feed(input);
  }
  @Post("/feeds/:id/points") point(
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return this.t.point(id, input);
  }
  @Get("/freshness") freshness() {
    return this.t.freshness();
  }
}
@Module({
  controllers: [PublicController, ApiController],
  providers: [
    { provide: Tally, useFactory: () => new Tally(pool()) },
    {
      provide: Auth,
      useFactory: (t: Tally) => new Auth(t.db),
      inject: [Tally],
    },
    OperatorGuard,
  ],
})
class AppModule {}
export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  const metrics = new Metrics();
  app.use((req: OperatorRequest, res: Response, next: NextFunction) => {
    req.traceId = randomUUID();
    const start = performance.now();
    res.setHeader("X-Trace-ID", req.traceId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    );
    res.on("finish", () => {
      const elapsed = performance.now() - start;
      metrics.requests++;
      metrics.elapsed += elapsed;
      if (res.statusCode >= 500) metrics.errors++;
      console.log(
        JSON.stringify({
          event: "http_completed",
          trace_id: req.traceId,
          method: req.method,
          route: req.route?.path ?? "static",
          status: res.statusCode,
          elapsed_ms: elapsed,
        }),
      );
    });
    next();
  });
  app.use(express.json({ limit: "512kb", strict: true }));
  app.use(
    (
      error: { type?: string },
      req: OperatorRequest,
      res: Response,
      next: NextFunction,
    ) => {
      if (error.type === "entity.too.large") {
        res.status(413).json({ error: "body_limit", trace_id: req.traceId });
        return;
      }
      if (error.type === "entity.parse.failed") {
        res.status(422).json({ error: "invalid_json", trace_id: req.traceId });
        return;
      }
      next(error);
    },
  );
  app.use("/metrics", async (req: OperatorRequest, res: Response) => {
    try {
      await app.get(Auth).authorize(req);
      res.type("text/plain").send(metrics.render());
    } catch (error) {
      res
        .status(error instanceof DomainError ? error.status : 503)
        .json({ error: "metrics_access_denied" });
    }
  });
  const web = resolve(process.env.TALLY_WEB ?? "apps/web/dist");
  if (existsSync(web))
    app.use(express.static(web, { index: "index.html", maxAge: 0 }));
  app.useGlobalFilters(new Errors());
  app.enableShutdownHooks();
  return app;
}
