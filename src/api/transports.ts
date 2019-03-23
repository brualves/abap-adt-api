import { parse } from "fast-xml-parser"
import { adtException, ValidateObjectUrl } from "../AdtException"
import { SAPRC } from "../AdtException"
import { AdtHTTP } from "../AdtHTTP"
import {
  fullParse,
  JSON2AbapXML,
  xmlArray,
  xmlNode,
  xmlNodeAttr
} from "../utilities"
import { Link } from "./objectstructure"

interface TransportHeader {
  TRKORR: string
  TRFUNCTION: string
  TRSTATUS: string
  TARSYSTEM: string
  AS4USER: string
  AS4DATE: string
  AS4TIME: string
  AS4TEXT: string
  CLIENT: string
}
interface TransportLock {
  HEADER: TransportHeader
  TASKS: TransportHeader[]
  OBJECT_KEY: {
    OBJ_NAME: string
    OBJECT: string
    PGMID: string
  }
}
export interface TransportInfo {
  PGMID: string
  OBJECT: string
  OBJECTNAME: string
  OPERATION: string
  DEVCLASS: string
  CTEXT: string
  KORRFLAG: string
  AS4USER: string
  PDEVCLASS: string
  DLVUNIT: string
  MESSAGES?: Array<{
    SEVERITY: string
    SPRSL: string
    ARBGB: string
    MSGNR: number
    VARIABLES: string[]
    TEXT: string
  }>
  NAMESPACE: string
  RESULT: string
  RECORDING: string
  EXISTING_REQ_ONLY: string
  TRANSPORTS: TransportHeader[]
  TADIRDEVC?: string
  URI?: string
  LOCKS?: TransportLock
}

function extractLocks(raw: any): TransportLock | undefined {
  const lock = raw && raw.CTS_OBJECT_LOCK
  if (!lock) return
  try {
    const holder = lock.LOCK_HOLDER
    const TASKS: TransportHeader[] = xmlArray(holder, "TASK_HEADERS").map(
      (x: any) => x.CTS_TASK_HEADER
    )
    return {
      HEADER: holder.REQ_HEADER,
      OBJECT_KEY: xmlNode(lock, "OBJECT_KEY"),
      TASKS
    }
  } catch {
    return
  }
}

function extractTransports(raw: any): TransportHeader[] {
  return xmlArray(raw, "CTS_REQUEST").map((x: any) => x.REQ_HEADER)
}

export async function transportInfo(
  h: AdtHTTP,
  URI: string,
  DEVCLASS: string = "",
  OPERATION: string = "I"
): Promise<TransportInfo> {
  ValidateObjectUrl(URI)
  const body = JSON2AbapXML({
    DEVCLASS,
    OPERATION,
    URI
  })

  const headers = {
    Accept:
      "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
    "Content-Type":
      "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData"
  }
  const response = await h.request("/sap/bc/adt/cts/transportchecks", {
    body,
    method: "POST",
    headers
  })
  // return parsePackageResponse(response.body)
  // tslint:disable-next-line: prefer-const
  let { REQUESTS, LOCKS, MESSAGES, ...header } = parse(response.body)[
    "asx:abap"
  ]["asx:values"].DATA
  if (MESSAGES) {
    MESSAGES = xmlArray(MESSAGES, "CTS_MESSAGE").map((m: any) => {
      // tslint:disable-next-line: prefer-const
      let { VARIABLES, ...rest } = m
      VARIABLES =
        (VARIABLES && xmlArray(m, "VARIABLES", "CTS_VARIABLE")).map(
          (v: any) => v.VARIABLE
        ) || []
      return { VARIABLES, ...rest }
    })
    MESSAGES.filter((m: any) => m.SEVERITY.match(/[EAX]/)).some((e: any) => {
      throw adtException(e.TEXT)
    })
  }
  const TRANSPORTS = extractTransports(REQUESTS)
  return { ...header, LOCKS: extractLocks(LOCKS), TRANSPORTS }
}

export async function createTransport(
  h: AdtHTTP,
  REF: string,
  REQUEST_TEXT: string,
  DEVCLASS: string,
  OPERATION: string = "I"
): Promise<string> {
  ValidateObjectUrl(REF)
  const body = JSON2AbapXML({ DEVCLASS, REQUEST_TEXT, REF, OPERATION })
  const response = await h.request("/sap/bc/adt/cts/transports", {
    body,
    headers: {
      Accept: "text/plain",
      "Content-Type":
        "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest"
    },
    method: "POST"
  })
  const transport = response.body.split("/").pop()
  return transport
}

export interface TransportObject {
  "tm:pgmid": string
  "tm:type": string
  "tm:name": string
  "tm:dummy_uri": string
  "tm:obj_info": string
}
export interface TransportTask {
  "tm:number": string
  "tm:owner": string
  "tm:desc": string
  "tm:status": string
  "tm:uri": string
  links: Link[]
  objects: TransportObject[]
}

export interface TransportRequest extends TransportTask {
  tasks: TransportTask[]
}

export interface TransportTarget {
  "tm:name": string
  "tm:desc": string
  modifiable: TransportRequest[]
  released: TransportRequest[]
}

export interface TransportsOfUser {
  workbench: TransportTarget[]
  customizing: TransportTarget[]
}
const parseTask = (t: any) => {
  const task = {
    ...xmlNodeAttr(t),
    links: xmlArray(t, "atom:link").map(xmlNodeAttr),
    objects: xmlArray(t, "tm:abap_object").map(xmlNodeAttr)
  }
  return task as TransportTask
}
const parseRequest = (r: any) => {
  const request: TransportRequest = {
    ...parseTask(r),
    tasks: xmlArray(r, "tm:task").map(parseTask)
  }
  return request
}
const parseTargets = (s: any) => ({
  ...xmlNodeAttr(s),
  modifiable: xmlArray(s, "tm:modifiable", "tm:request").map(parseRequest),
  released: xmlArray(s, "tm:released", "tm:request").map(parseRequest)
})

export async function userTransports(h: AdtHTTP, user: string, targets = true) {
  const response = await h.request("/sap/bc/adt/cts/transportrequests", {
    qs: { user, targets }
  })

  const raw = fullParse(response.body)
  const workbench = xmlArray(raw, "tm:root", "tm:workbench", "tm:target").map(
    parseTargets
  )
  const customizing = xmlArray(
    raw,
    "tm:root",
    "tm:customizing",
    "tm:target"
  ).map(parseTargets)

  const retval: TransportsOfUser = { workbench, customizing }
  return retval
}

function validateTransport(transportNumber: string) {
  if (transportNumber.length !== 10 || !transportNumber.match(/^[a-z]\w\wk/i))
    adtException("Invalid transport number:" + transportNumber)
}

export async function transportDelete(h: AdtHTTP, transportNumber: string) {
  validateTransport(transportNumber)

  await h.request("/sap/bc/adt/cts/transportrequests/" + transportNumber, {
    method: "DELETE",
    headers: { Accept: "application/*" }
  })
}
export interface TransportReleaseMessage {
  "chkrun:uri": string
  "chkrun:type": SAPRC
  "chkrun:shortText": string
}
export interface TransportReleaseReport {
  "chkrun:reporter": string
  "chkrun:triggeringUri": string
  "chkrun:status": "released" | "abortrelapifail" // perhaps other values?
  "chkrun:statusText": string
  messages: TransportReleaseMessage[]
}

export async function transportRelease(
  h: AdtHTTP,
  transportNumber: string,
  ignoreLocks = false,
  IgnoreATC = false
) {
  validateTransport(transportNumber)
  const action = IgnoreATC
    ? "relObjigchkatc"
    : ignoreLocks
    ? "relwithignlock"
    : "newreleasejobs"
  const response = await h.request(
    `/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`,
    {
      method: "POST",
      headers: { Accept: "application/*" }
    }
  )
  const raw = fullParse(response.body)
  const reports = xmlArray(
    raw,
    "tm:root",
    "tm:releasereports",
    "chkrun:checkReport"
  ).map((r: any) => {
    return {
      ...xmlNodeAttr(r),
      messages: xmlArray(
        r,
        "chkrun:checkMessageList",
        "chkrun:checkMessage"
      ).map(xmlNodeAttr)
    }
  })
  return reports as TransportReleaseReport[]
}
export interface TransportOwnerResponse {
  "tm:targetuser": string
  "tm:number": string
}

export async function transportSetOwner(
  h: AdtHTTP,
  transportNumber: string,
  targetuser: string
) {
  validateTransport(transportNumber)

  const response = await h.request(
    "/sap/bc/adt/cts/transportrequests/" + transportNumber,
    {
      method: "PUT",
      headers: { Accept: "application/*" },
      qs: { targetuser }
    }
  )
  const raw = fullParse(response.body)
  return xmlNodeAttr(xmlNode(raw, "tm:root")) as TransportOwnerResponse
}

export interface TransportAddUserResponse {
  "tm:number": string
  "tm:targetuser": string
  "tm:uri": string
  "tm:useraction": string
}
export async function transportAddUser(
  h: AdtHTTP,
  transportNumber: string,
  user: string
) {
  validateTransport(transportNumber)

  const body = `<?xml version="1.0" encoding="ASCII"?>
  <tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${transportNumber}"
  tm:targetuser="${user}" tm:useraction="newtask"/>`

  const response = await h.request(
    "/sap/bc/adt/cts/transportrequests/" + transportNumber + "/tasks",
    {
      method: "POST",
      body,
      headers: { Accept: "application/*", "Content-Type": "text/plain" }
    }
  )
  const raw = fullParse(response.body)
  return xmlNodeAttr(xmlNode(raw, "tm:root")) as TransportAddUserResponse
}

export interface SystemUser {
  id: string
  title: string
}

export async function systemUsers(h: AdtHTTP) {
  const response = await h.request("/sap/bc/adt/system/users", {
    headers: { Accept: "application/*" }
  })
  const raw = parse(response.body)
  return xmlArray(raw, "atom:feed", "atom:entry").map(
    (r: any): SystemUser => ({ id: r["atom:id"], title: r["atom:title"] })
  )
}
