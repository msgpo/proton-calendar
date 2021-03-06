import { c } from 'ttag';
import { Prompt } from 'react-router';
import { noop } from 'proton-shared/lib/helpers/function';
import React, { useImperativeHandle, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useEventManager, useGetAddressKeys, useGetCalendarKeys, useModals } from 'react-components';
import { useReadCalendarBootstrap } from 'react-components/hooks/useGetCalendarBootstrap';

import { format, isSameDay } from 'proton-shared/lib/date-fns-utc';
import { dateLocale } from 'proton-shared/lib/i18n';
import { getFormattedWeekdays } from 'proton-shared/lib/date/date';
import createOrUpdateEvent from 'proton-shared/lib/calendar/integration/createOrUpdateEvent';
import { deleteEvent, updateCalendar } from 'proton-shared/lib/api/calendars';
import { omit } from 'proton-shared/lib/helpers/object';
import { getIsCalendarDisabled, getIsCalendarProbablyActive } from 'proton-shared/lib/calendar/calendar';
import { getOccurrences } from 'proton-shared/lib/calendar/recurring';

import { getExistingEvent, getInitialModel, hasDoneChanges } from '../../components/eventModal/eventForm/state';
import { getTimeInUtc } from '../../components/eventModal/eventForm/time';
import { ACTIONS, TYPE } from '../../components/calendar/interactions/constants';
import { modelToVeventComponent } from '../../components/eventModal/eventForm/modelToProperties';
import { sortEvents, sortWithTemporaryEvent } from '../../components/calendar/layout';

import CreateEventModal from '../../components/eventModal/CreateEventModal';
import Popover from '../../components/calendar/Popover';
import CreateEventPopover from '../../components/eventModal/CreateEventPopover';
import EventPopover from '../../components/events/EventPopover';
import MorePopoverEvent from '../../components/events/MorePopoverEvent';

import { getCreateTemporaryEvent, getEditTemporaryEvent, getTemporaryEvent, getUpdatedDateTime } from './eventHelper';
import CalendarView from './CalendarView';
import useUnload from '../../hooks/useUnload';
import { findUpwards } from '../../components/calendar/mouseHelpers/domHelpers';
import CloseConfirmationModal from './confirmationModals/CloseConfirmation';
import DeleteConfirmModal from './confirmationModals/DeleteConfirmModal';
import DeleteRecurringConfirmModal from './confirmationModals/DeleteRecurringConfirmModal';
import EditRecurringConfirmation from './confirmationModals/EditRecurringConfirmation';
import { RECURRING_DELETE_TYPES } from '../../constants';
import deleteSingleRecurrence from './recurrence/deleteSingleRecurrence';
import getMemberAndAddress from './getMemberAndAddress';
import deleteFutureRecurrence from './recurrence/deleteFutureRecurrence';

const getNormalizedTime = (isAllDay, initial, dateFromCalendar) => {
    if (!isAllDay) {
        return dateFromCalendar;
    }
    const result = new Date(dateFromCalendar);
    // If it's an all day event, the hour and minutes are stripped from the temporary event.
    result.setUTCHours(initial.time.getHours(), initial.time.getMinutes());
    return result;
};

const InteractiveCalendarView = ({
    view,
    isLoading,
    isNarrow,

    tzid,
    primaryTimezone,
    secondaryTimezone,
    secondaryTimezoneOffset,

    displayWeekNumbers,
    displaySecondaryTimezone,
    weekStartsOn,

    now,
    date,
    dateRange,
    events,

    onClickDate,
    onChangeDate,
    onInteraction,

    activeCalendars,
    addresses,
    defaultCalendar,
    defaultCalendarBootstrap,

    interactiveRef,
    containerRef,
    timeGridViewRef
}) => {
    const api = useApi();
    const { call } = useEventManager();
    const { createModal, getModal, hideModal, removeModal } = useModals();

    const [eventModalID, setEventModalID] = useState();
    const readCalendarBootstrap = useReadCalendarBootstrap();
    const getCalendarKeys = useGetCalendarKeys();
    const getAddressKeys = useGetAddressKeys();

    const [interactiveData, setInteractiveData] = useState();

    const { temporaryEvent, targetEventData, targetMoreData } = interactiveData || {};

    const { tmpData, tmpDataOriginal, data: { Event: tmpEvent } = {} } = temporaryEvent || {};

    const isCreatingEvent = tmpData && !tmpEvent;
    const isEditingEvent = tmpData && !!tmpEvent;
    const isInTemporaryBlocking = tmpData && hasDoneChanges(tmpData, tmpDataOriginal, isEditingEvent);
    const isScrollDisabled = interactiveData && !temporaryEvent;

    useEffect(() => {
        onInteraction && onInteraction(!!temporaryEvent);
    }, [!!temporaryEvent]);

    useUnload(isInTemporaryBlocking ? c('Alert').t`By leaving now, you will lose your event.` : undefined);

    const sortedEvents = useMemo(() => {
        return sortEvents(events.concat());
    }, [events]);

    const sortedEventsWithTemporary = useMemo(() => {
        return sortWithTemporaryEvent(sortedEvents, temporaryEvent);
    }, [temporaryEvent, sortedEvents]);

    const handleSetTemporaryEventModel = (model) => {
        const newTemporaryEvent = getTemporaryEvent(temporaryEvent, model, tzid);

        // If you select a date outside of the current range.
        const newStartDay = newTemporaryEvent.start;
        const isInRange = isNarrow
            ? isSameDay(date, newStartDay)
            : newStartDay >= dateRange[0] && dateRange[1] >= newStartDay;
        if (!isInRange) {
            onChangeDate(newTemporaryEvent.start);
        }

        setInteractiveData({
            ...interactiveData,
            temporaryEvent: newTemporaryEvent
        });
    };

    const getInitialDate = () => {
        return new Date(
            Date.UTC(
                date.getUTCFullYear(),
                date.getUTCMonth(),
                date.getUTCDate(),
                now.getUTCHours(),
                now.getUTCMinutes()
            )
        );
    };

    const getCreateModel = ({ isAllDay }) => {
        const initialDate = getInitialDate();

        const { Members = [], CalendarSettings } = defaultCalendarBootstrap;
        const [Member = {}] = Members;
        const Address = addresses.find(({ Email }) => Member.Email === Email);
        if (!Member || !Address) {
            return;
        }
        return getInitialModel({
            initialDate,
            CalendarSettings,
            Calendar: defaultCalendar,
            Calendars: activeCalendars,
            Addresses: addresses,
            Members,
            Member,
            Address,
            isAllDay,
            tzid
        });
    };

    const getUpdateModel = ({ Calendar, Event, readEvent }) => {
        const initialDate = getInitialDate();

        const { Members = [], CalendarSettings } = readCalendarBootstrap(Calendar.ID);
        const { Member, Address } = getMemberAndAddress(addresses, Members, Event.Author);

        const createResult = getInitialModel({
            initialDate,
            CalendarSettings,
            Calendar,
            Calendars: activeCalendars,
            Addresses: addresses,
            Members,
            Member,
            Address,
            isAllDay: false,
            tzid
        });
        const [[veventComponent, personalMap] = [], promise, error] = readEvent(Calendar.ID, Event.ID);
        if (!veventComponent || !personalMap || promise || error) {
            return;
        }
        const eventResult = getExistingEvent({
            veventComponent,
            veventValarmComponent: personalMap[Member.ID],
            tzid
        });
        return {
            ...createResult,
            ...eventResult
        };
    };

    const handleMouseDown = ({ action: originalAction, payload: originalPayload }) => {
        if (originalAction === ACTIONS.EVENT_DOWN) {
            const { event, type } = originalPayload;

            // If already creating something in blocking mode and not touching on the temporary event.
            if (temporaryEvent && event.id !== 'tmp' && isInTemporaryBlocking) {
                return;
            }

            const targetCalendar = (event && event.data && event.data.Calendar) || undefined;

            const isAllowedToTouchEvent = true;
            let isAllowedToMoveEvent = getIsCalendarProbablyActive(targetCalendar);

            if (!isAllowedToTouchEvent) {
                return;
            }

            let newTemporaryModel = temporaryEvent && event.id === 'tmp' ? temporaryEvent.tmpData : undefined;
            let newTemporaryEvent = temporaryEvent && event.id === 'tmp' ? temporaryEvent : undefined;
            let initialModel = newTemporaryModel;

            return ({ action, payload }) => {
                if (action === ACTIONS.EVENT_UP) {
                    const { idx } = payload;

                    setInteractiveData({
                        temporaryEvent: temporaryEvent && event.id === 'tmp' ? temporaryEvent : undefined,
                        targetEventData: { id: event.id, idx, type }
                    });
                    return;
                }

                if (!isAllowedToMoveEvent) {
                    return;
                }

                if (!newTemporaryModel) {
                    newTemporaryModel = getUpdateModel(event.data);
                    if (!newTemporaryModel) {
                        isAllowedToMoveEvent = false;
                        return;
                    }
                    initialModel = newTemporaryModel;
                }

                if (!newTemporaryEvent) {
                    newTemporaryEvent = getEditTemporaryEvent(event, newTemporaryModel, tzid);
                }

                const {
                    result: { start, end }
                } = payload;

                const { start: initialStart, end: initialEnd } = initialModel;

                const normalizedStart = getNormalizedTime(newTemporaryModel.isAllDay, initialStart, start);
                const normalizedEnd = getNormalizedTime(newTemporaryModel.isAllDay, initialEnd, end);

                newTemporaryModel = getUpdatedDateTime(newTemporaryModel, {
                    isAllDay: newTemporaryModel.isAllDay,
                    start: normalizedStart,
                    end: normalizedEnd,
                    tzid
                });
                newTemporaryEvent = getTemporaryEvent(newTemporaryEvent, newTemporaryModel, tzid);

                if (action === ACTIONS.EVENT_MOVE) {
                    setInteractiveData({
                        temporaryEvent: newTemporaryEvent
                    });
                }
                if (action === ACTIONS.EVENT_MOVE_UP) {
                    const { idx } = payload;

                    setInteractiveData({
                        temporaryEvent: newTemporaryEvent,
                        targetEventData: { id: 'tmp', idx, type }
                    });
                }
            };
        }

        if (originalAction === ACTIONS.CREATE_DOWN) {
            if (!defaultCalendarBootstrap) {
                return;
            }

            const { type } = originalPayload;
            const isFromAllDay = type === TYPE.DAYGRID;

            // If there is any popover or temporary event
            if (interactiveData && !isInTemporaryBlocking) {
                setInteractiveData();
                return;
            }

            let newTemporaryModel =
                temporaryEvent && isInTemporaryBlocking
                    ? temporaryEvent.tmpData
                    : getCreateModel({ isAllDay: isFromAllDay });

            const isAllowed = !!newTemporaryModel;

            if (!isAllowed) {
                return;
            }

            const { start: initialStart, end: initialEnd } = newTemporaryModel;
            let newTemporaryEvent = temporaryEvent || getCreateTemporaryEvent(defaultCalendar);

            const eventDuration = getTimeInUtc(initialEnd) - getTimeInUtc(initialStart);

            return ({ action, payload }) => {
                const {
                    result: { start, end },
                    idx
                } = payload;

                const normalizedStart = start;
                const normalizedEnd =
                    action === ACTIONS.CREATE_UP
                        ? isFromAllDay
                            ? start
                            : new Date(normalizedStart.getTime() + eventDuration)
                        : end;

                newTemporaryModel = getUpdatedDateTime(newTemporaryModel, {
                    isAllDay: isFromAllDay,
                    start: normalizedStart,
                    end: normalizedEnd,
                    tzid
                });
                newTemporaryEvent = getTemporaryEvent(newTemporaryEvent, newTemporaryModel, tzid);

                if (action === ACTIONS.CREATE_MOVE) {
                    setInteractiveData({ temporaryEvent: newTemporaryEvent });
                }
                if (action === ACTIONS.CREATE_UP || action === ACTIONS.CREATE_MOVE_UP) {
                    setInteractiveData({
                        temporaryEvent: newTemporaryEvent,
                        targetEventData: { id: 'tmp', idx, type }
                    });
                }
            };
        }

        if (originalAction === ACTIONS.MORE_DOWN) {
            const { idx, row, events, date } = originalPayload;
            return ({ action }) => {
                if (action === ACTIONS.MORE_UP) {
                    setInteractiveData({
                        targetMoreData: { idx, row, events, date }
                    });
                }
            };
        }
    };

    const handleClickEvent = ({ id, idx, type }) => {
        setInteractiveData({
            ...interactiveData,
            targetEventData: { id, idx, type }
        });
    };

    const handleRecurringUpdateConfirmation = () => {
        return new Promise((resolve, reject) => {
            createModal(<EditRecurringConfirmation onClose={reject} onConfirm={resolve} />);
        });
    };

    const handleSaveEventHelper = async ({ Event, veventComponent, calendarID, addressID, memberID }) => {
        const oldCalendarID = !!Event && Event.CalendarID !== calendarID ? Event.CalendarID : undefined;
        const [addressKeys, newCalendarKeys, oldCalendarKeys] = await Promise.all([
            getAddressKeys(addressID),
            getCalendarKeys(calendarID),
            oldCalendarID ? getCalendarKeys(oldCalendarID) : undefined
        ]);

        await createOrUpdateEvent({
            Event,
            veventComponent,
            memberID,
            calendarID,
            addressKeys,
            oldCalendarKeys: oldCalendarKeys || newCalendarKeys,
            calendarKeys: newCalendarKeys,
            api
        });

        const calendar = activeCalendars.find(({ ID }) => ID === calendarID);
        if (calendar && !calendar.Display) {
            await api(updateCalendar(calendarID, { Display: 1 }));
        }

        await call();
    };

    const handleSaveEvent = async ({ tmpOriginalTarget, tmpData, data: { Event, readEvent } }) => {
        const {
            calendar: { id: calendarID },
            member: { memberID, addressID }
        } = tmpData;

        const isRecurringUpdate = Event && readEvent && tmpOriginalTarget && tmpOriginalTarget.isRecurring;
        !!isRecurringUpdate && (await handleRecurringUpdateConfirmation());

        // All updates will remove any existing exdates since they would be more complicated to normalize
        const veventComponent = omit(modelToVeventComponent(tmpData), ['exdate']);

        return handleSaveEventHelper({
            Event,
            veventComponent,
            calendarID,
            memberID,
            addressID
        });
    };

    const handleCloseConfirmation = () => {
        return new Promise((resolve, reject) => {
            createModal(<CloseConfirmationModal onClose={reject} onConfirm={resolve} />);
        });
    };

    const handleDeleteConfirmation = (title, message) => {
        return new Promise((resolve, reject) => {
            createModal(<DeleteConfirmModal title={title} message={message} onClose={reject} onConfirm={resolve} />);
        });
    };

    const handleDeleteRecurringConfirmation = (hasDeleteAll) => {
        return new Promise((resolve, reject) => {
            createModal(
                <DeleteRecurringConfirmModal hasDeleteAll={hasDeleteAll} onClose={reject} onConfirm={resolve} />
            );
        });
    };

    const handleDeleteEvent = async (
        { CalendarID, ID: EventID },
        { isRecurring, recurrence, data: { readEvent, Calendar, Event } }
    ) => {
        const handleDeleteAll = async () => {
            await api(deleteEvent(CalendarID, EventID));
            await call();
        };

        if (isRecurring && recurrence && !recurrence.isSingleOccurrence) {
            const customTitle = c('Info').t`Delete events`;
            const customMessage = c('Info').t`Would you like to delete all the events in the series?`;

            if (getIsCalendarDisabled(Calendar)) {
                await handleDeleteConfirmation(customTitle, customMessage);
                await handleDeleteAll();
                return;
            }
            const calendarBootstrap = readCalendarBootstrap(Calendar.ID);
            const { Member, Address } = getMemberAndAddress(addresses, calendarBootstrap.Members, Event.Author);
            const [[veventComponent, personalMap] = [], promise, error] = readEvent(Calendar.ID, Event.ID);
            if (error) {
                // allow to delete recurring event even if there are read errors
                await handleDeleteConfirmation(customTitle, customMessage);
                await handleDeleteAll();
                return;
            }
            if (!veventComponent || !personalMap || promise) {
                return;
            }
            // Dry-run delete this and future recurrences
            const veventFutureDeleted = deleteFutureRecurrence(
                veventComponent,
                recurrence.localStart,
                recurrence.occurrenceNumber
            );
            // If we would end up with at least 1 occurrence, the delete this and future option is allowed
            const isDeleteThisAndFutureAllowed = getOccurrences(veventFutureDeleted, 2).length >= 1;

            const deleteType = await handleDeleteRecurringConfirmation(
                !isDeleteThisAndFutureAllowed || recurrence.occurrenceNumber === 1
            );

            if (deleteType === RECURRING_DELETE_TYPES.SINGLE || deleteType === RECURRING_DELETE_TYPES.FUTURE) {
                const updatedVeventComponent =
                    deleteType === RECURRING_DELETE_TYPES.SINGLE
                        ? deleteSingleRecurrence(veventComponent, recurrence.localStart, recurrence.occurrenceNumber)
                        : deleteFutureRecurrence(veventComponent, recurrence.localStart, recurrence.occurrenceNumber);

                const { components: valarmComponents = [] } = personalMap[Member.ID] || {};
                const componentWithValarm = {
                    ...updatedVeventComponent,
                    components: valarmComponents
                };

                await handleSaveEventHelper({
                    Event,
                    veventComponent: componentWithValarm,
                    calendarID: Calendar.ID,
                    addressID: Address.ID,
                    memberID: Member.ID
                });
            }

            if (deleteType === RECURRING_DELETE_TYPES.ALL) {
                await handleDeleteAll();
            }

            return;
        }

        await handleDeleteConfirmation();
        await handleDeleteAll();
    };

    const safeCloseTemporaryEventAndPopover = () => {
        setInteractiveData();
    };

    const handleConfirmDeleteTemporary = ({ ask = false } = {}) => {
        if (isInTemporaryBlocking) {
            if (!ask) {
                return Promise.reject(new Error('Keep event'));
            }
            return handleCloseConfirmation().catch(() => Promise.reject(new Error('Keep event')));
        }
        return Promise.resolve();
    };

    const handleEditEvent = (temporaryEvent) => {
        // Close the popover only
        setInteractiveData({ temporaryEvent });
        setEventModalID(createModal());
    };

    const handleCreateEvent = () => {
        const newTemporaryEvent = getTemporaryEvent(
            getCreateTemporaryEvent(defaultCalendar),
            getCreateModel({ isAllDay: false }),
            tzid
        );
        handleEditEvent(newTemporaryEvent);
    };

    useImperativeHandle(interactiveRef, () => ({
        closePopover: () => {
            handleConfirmDeleteTemporary({ ask: true })
                .then(safeCloseTemporaryEventAndPopover)
                .catch(noop);
        },
        createEvent: () => {
            handleCreateEvent();
        }
    }));

    const [targetEventRef, setTargetEventRef] = useState();
    const [targetMoreRef, setTargetMoreRef] = useState();

    const targetEvent = useMemo(() => {
        if (!targetEventData) {
            return;
        }
        return sortedEventsWithTemporary.find(({ id }) => id === targetEventData.id);
    }, [targetEventData, sortedEventsWithTemporary]);

    const autoCloseRef = useRef();
    autoCloseRef.current = ({ ask }) => {
        handleConfirmDeleteTemporary({ ask })
            .then(safeCloseTemporaryEventAndPopover)
            .catch(noop);
    };

    useEffect(() => {
        if (!containerRef) {
            return;
        }
        // React bubbles event through https://github.com/facebook/react/issues/11387 portals, so set up a click
        // listener to prevent clicks on the popover to be interpreted as an auto close click
        const handler = (e) => {
            // Only ask to auto close if an action wasn't clicked.
            if (
                findUpwards(e.target, e.currentTarget, (el) => {
                    return ['BUTTON', 'A', 'SELECT', 'INPUT'].includes(el.nodeName);
                })
            ) {
                autoCloseRef.current({ ask: false });
                return;
            }
            autoCloseRef.current({ ask: true });
        };
        containerRef.addEventListener('click', handler);
        return () => containerRef.removeEventListener('click', handler);
    }, [containerRef]);

    const formatDate = useCallback(
        (utcDate) => {
            return format(utcDate, 'PP', { locale: dateLocale });
        },
        [dateLocale]
    );

    const formatTime = useCallback(
        (utcDate) => {
            return format(utcDate, 'p', { locale: dateLocale });
        },
        [dateLocale]
    );

    const weekdaysLong = useMemo(() => {
        return getFormattedWeekdays('cccc', { locale: dateLocale });
    }, [dateLocale]);

    return (
        <>
            <CalendarView
                view={view}
                isNarrow={isNarrow}
                isInteractionEnabled={!isLoading}
                onMouseDown={handleMouseDown}
                tzid={tzid}
                primaryTimezone={primaryTimezone}
                secondaryTimezone={secondaryTimezone}
                secondaryTimezoneOffset={secondaryTimezoneOffset}
                targetEventData={targetEventData}
                targetEventRef={setTargetEventRef}
                targetMoreRef={setTargetMoreRef}
                targetMoreData={targetMoreData}
                displayWeekNumbers={displayWeekNumbers}
                displaySecondaryTimezone={displaySecondaryTimezone}
                now={now}
                date={date}
                dateRange={dateRange}
                events={sortedEventsWithTemporary}
                onClickDate={onClickDate}
                formatTime={formatTime}
                formatDate={formatDate}
                weekdaysLong={weekdaysLong}
                timeGridViewRef={timeGridViewRef}
                isScrollDisabled={isScrollDisabled}
            />
            <Popover
                containerRef={document.body}
                targetRef={targetEventRef}
                isOpen={!!targetEvent}
                once={true}
                when={targetEvent ? targetEvent.start : undefined}
            >
                {({ style, ref }) => {
                    if (targetEvent.id === 'tmp') {
                        return (
                            <CreateEventPopover
                                isNarrow={isNarrow}
                                style={style}
                                popoverRef={ref}
                                tzid={tzid}
                                model={tmpData}
                                displayWeekNumbers={displayWeekNumbers}
                                weekStartsOn={weekStartsOn}
                                setModel={handleSetTemporaryEventModel}
                                onSave={() => handleSaveEvent(temporaryEvent)}
                                onEdit={() => handleEditEvent(temporaryEvent)}
                                onClose={({ safe = false } = {}) => {
                                    if (safe) {
                                        return safeCloseTemporaryEventAndPopover();
                                    }
                                    handleConfirmDeleteTemporary({ ask: true })
                                        .then(safeCloseTemporaryEventAndPopover)
                                        .catch(noop);
                                }}
                                isCreateEvent={isCreatingEvent}
                            />
                        );
                    }
                    return (
                        <EventPopover
                            isNarrow={isNarrow}
                            style={style}
                            popoverRef={ref}
                            event={targetEvent}
                            tzid={tzid}
                            weekStartsOn={weekStartsOn}
                            formatTime={formatTime}
                            onDelete={() => handleDeleteEvent(targetEvent.data.Event, targetEvent)}
                            onEdit={() => {
                                const newTemporaryModel = getUpdateModel(targetEvent.data);
                                const newTemporaryEvent = getTemporaryEvent(
                                    getEditTemporaryEvent(targetEvent, newTemporaryModel, tzid),
                                    newTemporaryModel,
                                    tzid
                                );
                                handleEditEvent(newTemporaryEvent);
                            }}
                            onClose={safeCloseTemporaryEventAndPopover}
                        />
                    );
                }}
            </Popover>
            <Popover containerRef={document.body} targetRef={targetMoreRef} isOpen={!!targetMoreData} once={true}>
                {({ style, ref }) => {
                    return (
                        <MorePopoverEvent
                            tzid={tzid}
                            isNarrow={isNarrow}
                            style={style}
                            popoverRef={ref}
                            date={targetMoreData.date}
                            events={targetMoreData.events}
                            targetEventRef={setTargetEventRef}
                            targetEventData={targetEventData}
                            formatTime={formatTime}
                            onClickEvent={handleClickEvent}
                            onClose={safeCloseTemporaryEventAndPopover}
                        />
                    );
                }}
            </Popover>
            <Prompt
                message={(location) => {
                    if (isInTemporaryBlocking && location.pathname.includes('settings')) {
                        handleConfirmDeleteTemporary({ ask: true })
                            .then(safeCloseTemporaryEventAndPopover)
                            .catch(noop);
                        return false;
                    }
                    return true;
                }}
            />

            {eventModalID && tmpData ? (
                <CreateEventModal
                    isNarrow={isNarrow}
                    displayWeekNumbers={displayWeekNumbers}
                    weekStartsOn={weekStartsOn}
                    tzid={tzid}
                    model={tmpData}
                    setModel={handleSetTemporaryEventModel}
                    onSave={() => handleSaveEvent(temporaryEvent)}
                    onDelete={() => {
                        if (
                            !temporaryEvent ||
                            !temporaryEvent.data ||
                            !temporaryEvent.data.Event ||
                            !temporaryEvent.tmpOriginalTarget
                        ) {
                            return;
                        }
                        return handleDeleteEvent(temporaryEvent.data.Event, temporaryEvent.tmpOriginalTarget);
                    }}
                    onClose={({ safe = false } = {}) => {
                        if (safe) {
                            return hideModal(eventModalID);
                        }
                        handleConfirmDeleteTemporary({ ask: true })
                            .then(() => hideModal(eventModalID))
                            .catch(noop);
                    }}
                    onExit={() => {
                        removeModal(eventModalID);
                        setEventModalID();
                        safeCloseTemporaryEventAndPopover();
                    }}
                    isCreateEvent={isCreatingEvent}
                    {...getModal(eventModalID)}
                />
            ) : null}
        </>
    );
};

export default InteractiveCalendarView;
