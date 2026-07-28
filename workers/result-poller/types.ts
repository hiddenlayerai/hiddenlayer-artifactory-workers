export interface ScheduledEventRequest {
  /** The trigger ID of the event */
  triggerID: string;
}

export interface ScheduledEventResponse {
  /** Message to print to the log, in case of an error it will be printed as a warning */
  message: string;
}
